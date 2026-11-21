#!/usr/bin/env node
// 巡检一轮的脚本骨架：主代理只读 start 的决策包、派子代理、审批决定、跑 run 与 finish。
//
// 用法（--dir 缺省 /tmp/t3-patrol，四个子命令共用）：
//   node patrol-round.mjs start --self <本线程 id>
//       跑完整快照（写 <dir>/snapshot.json），代挂缺失的 PR 监听，按批写研判输入 <dir>/judge-N.json，
//       题库有缺口时写补货输入 <dir>/refill/*.json；stdout 输出决策包（字段见 packOf）。
//   node patrol-round.mjs review <judge-N.out.json …>
//       合并研判结果到 <dir>/decisions.json，输出一行一条的审批表；主代理改 decisions.json 即可否决或修改。
//   node patrol-round.mjs run
//       执行 decisions.json：交接入账/销账，calls 逐条调用并回读（消息等到对应 run 启动，最多 2 分钟；改名、settle 核状态）。
//       重跑只补跑没有成功结果的调用，改过失败项的 calls 后再跑一次即可补救。
//   node patrol-round.mjs finish --tier <档位 name> [--quota-failure] [--dispatch <dispatch-queue 输出>]
//       写线程状态表与本轮记账，stdout 输出报告骨架（Markdown）。
// 研判结果（每项一条线程）：{ environmentId, threadId, link, title, kind, action, summary, calls?, handoff?, handoffResolve?,
//   waitFor?, recheckMinutes?, needsUser?, blocker? }，格式见 references/judge.md。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { call, connect, hasSession, NO_SESSION } from "./t3-mcp.mjs";
import { runCalls, watchAll } from "./patrol-batch.mjs";
import { commitRound, loadState, putHandoff, recordDecisions, resolveHandoff, saveState, threadKey } from "./patrol-state.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(SCRIPTS, "..", "..", "t3-dispatch", "scripts");
const QUOTA = /quota|usage_exhausted|额度|rate.?limit|\b429\b/i;
const ACTIONS = ["send", "interrupt", "settle", "rename", "handoff", "none", "report"];

// 档位建议只看事实；探测与换档仍按 recovery.md。
export function tierOf(snap) {
  const ladder = snap.modelLadder ?? [];
  const first = ladder[0]?.name ?? null;
  const failed = (snap.environments ?? []).flatMap((e) => e.failedThreads ?? []).filter((t) => QUOTA.test(JSON.stringify(t.runs ?? t)));
  if (failed.length) return { suggest: null, reason: `本轮 ${failed.length} 条失败疑似额度耗尽，按 recovery.md 判档`, quotaThreads: failed.map((t) => t.link) };
  if (snap.lastRound?.quotaFailure) return { suggest: first, reason: "上一轮有额度失败，按 recovery.md 先探测首选档", probe: true };
  return { suggest: first, reason: "上一轮与本轮均无额度失败" };
}

// 报告开头的档位依据：本轮出过额度失败时以它为准，否则沿用开局建议。
export function tierReasonOf(snap, tier, quotaFailure) {
  const first = snap.modelLadder?.[0]?.name ?? null;
  if (quotaFailure) return tier === first ? "本轮出现额度失败，失败任务已按阶梯换档重派，首选档保持" : `本轮出现额度失败，按阶梯改用 ${tier}`;
  const { suggest, reason } = tierOf(snap);
  return suggest && suggest !== tier ? `${reason}；按 recovery.md 改用 ${tier}` : reason;
}

// 研判输入：每批同一环境，最多 size 条；有事候选、过滤外失败、静默线程的命名、来源不在候选里的待交接。
export function judgeBatches(snap, { size = 4 } = {}) {
  const batches = [];
  const handoffs = snap.pendingHandoffs ?? [];
  const seen = new Set();
  for (const env of snap.environments ?? []) {
    if (env.error) continue;
    const items = [];
    for (const c of env.candidates ?? []) {
      if (c.triage === "hot") items.push({ kind: "hot", ...c });
      else if ((env.needsRenameThreads ?? []).some((r) => r.id === c.id)) items.push({ kind: "rename", ...c, ...(env.needsRenameThreads.find((r) => r.id === c.id)) });
      seen.add(threadKey(env.environmentId, c.id));
    }
    for (const f of env.failedThreads ?? []) if (f.source === "filtered") items.push({ kind: "failed", ...f });
    for (const h of handoffs) {
      if (h.sourceEnvironmentId === env.environmentId && !seen.has(threadKey(h.sourceEnvironmentId, h.sourceThreadId))) items.push({ kind: "handoff", id: h.sourceThreadId, link: h.sourceLink, title: h.task, pendingHandoff: h });
    }
    for (const it of items) {
      const h = handoffs.find((x) => x.sourceEnvironmentId === env.environmentId && x.sourceThreadId === it.id);
      if (h) it.pendingHandoff = h;
    }
    for (let i = 0; i < items.length; i += size) batches.push({ environmentId: env.environmentId, alias: env.alias ?? env.label, items: items.slice(i, i + size) });
  }
  return batches;
}

const poolText = (cap) => (cap?.pools ?? []).map((p) => `${p.name} ${p.used}/${p.max}`).join("，");

export function packOf(snap, { dir, batches, watch = [], dispatch }) {
  const envs = (snap.environments ?? []).map((e) => ({
    alias: e.alias ?? e.label, environmentId: e.environmentId,
    ...(e.error ? { error: e.error } : {
      ...e.checks,
      capacity: poolText(e.capacity), ...(e.capacity?.blocked?.length ? { blocked: e.capacity.blocked } : {}),
      ...(e.capacity?.unverifiedThreads?.length ? { unverified: e.capacity.unverifiedThreads.length } : {}),
    }),
  }));
  const failedWatch = watch.filter((w) => w.error);
  const warnings = [...(snap.config?.warnings ?? []), ...(snap.environmentsFile?.warnings ?? [])];
  const ef = snap.environmentsFile ?? {};
  if (ef.unlisted?.length || ef.missing?.length) warnings.push(`environments.json 与本轮环境不一致：unlisted ${ef.unlisted?.length ?? 0}，missing ${ef.missing?.length ?? 0}，按 snapshot.md「设备对照」重认`);
  return {
    dir, snapshot: join(dir, "snapshot.json"), generatedAt: snap.generatedAt,
    triage: snap.triage, lastRound: snap.lastRound, tier: tierOf(snap), modelLadder: snap.modelLadder,
    ...(warnings.length ? { warnings } : {}),
    ...([...(snap.config?.errors ?? []), ...(ef.errors ?? [])].length ? { errors: [...(snap.config?.errors ?? []), ...(ef.errors ?? [])] } : {}),
    unreachable: (snap.unreachable ?? []).map((u) => u.alias ?? u.label),
    environments: envs,
    watch: { added: watch.filter((w) => w.result).length, skipped: watch.filter((w) => w.skipped).length, failed: failedWatch.map((w) => `${w.url}：${w.error}`) },
    judge: batches.map((b, i) => ({ file: join(dir, `judge-${i + 1}.json`), out: join(dir, `judge-${i + 1}.out.json`), env: b.alias, items: b.items.length })),
    handoffs: (snap.pendingHandoffs ?? []).map((h) => ({ source: h.sourceLink, target: h.targetEnvironmentId, blocker: h.blocker, launched: h.launchedThreadLink ?? null })),
    dispatch,
  };
}

export function judgeInput(snap, batch, { out }) {
  return {
    generatedAt: snap.generatedAt, lastRound: snap.lastRound,
    thresholds: snap.config?.thresholds, convergenceAudit: snap.config?.convergenceAudit, modelLadder: snap.modelLadder,
    environment: { alias: batch.alias, environmentId: batch.environmentId },
    items: batch.items, out,
    commands: {
      evidence: `node ${join(SCRIPTS, "patrol-evidence.mjs")} --thread <threadId>@${batch.environmentId} [--pr <owner/repo#N>@<PR URL>] [--after <position>] [--queue]`,
    },
  };
}

export function mergeDecisions(lists) {
  const out = new Map();
  for (const d of lists.flat()) {
    if (!d?.threadId || !ACTIONS.includes(d.action)) throw new Error(`研判结果缺 threadId 或 action 无效：${JSON.stringify(d).slice(0, 200)}`);
    out.set(threadKey(d.environmentId, d.threadId), d);
  }
  return [...out.values()];
}

const reviewLine = (d) => [d.title ?? d.threadId, d.kind, d.action, d.summary,
  ...(d.calls ?? []).map((c) => `${c.tool}${c.args?.message ? `「${String(c.args.message).slice(0, 80)}」` : c.args?.title ? `「${c.args.title}」` : ""}`),
  d.needsUser ? `需要你决定：${d.needsUser}` : "", d.blocker ? `阻塞：${d.blocker}` : ""].filter(Boolean).join("｜");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STARTED = new Set(["starting", "running", "completed", "failed", "interrupted", "cancelled"]);
const VERIFY_STEP = Number(process.env.T3_PATROL_VERIFY_STEP_MS ?? 15000);
const VERIFY_MAX = Number(process.env.T3_PATROL_VERIFY_MAX_MS ?? 120000);

// 回读写操作的可观察结果：消息看对应 run，改名看标题，settle 看状态。
async function verify(c, result) {
  const scope = { environmentId: c.args.environmentId, threadId: c.args.threadId };
  for (let waited = 0; ; waited += VERIFY_STEP) {
    const h = await call("t3_thread_read", { ...scope, limit: 1, maxCharsPerItem: 1 }).catch((e) => ({ error: e.message }));
    if (h.error) return { verified: "unknown", error: h.error };
    if (c.tool === "t3_thread_update") return { verified: h.thread?.title === c.args.title ? "renamed" : "title-mismatch" };
    if (c.tool === "t3_thread_organize") return { verified: h.thread?.settled ? "settled" : "not-settled" };
    if (c.tool !== "t3_thread_send") return { verified: h.thread?.status ?? "unknown" };
    const runs = h.recentRuns ?? [];
    const run = (result?.runId && runs.find((r) => (r.runId ?? r.id) === result.runId)) || runs[0];
    if (run && STARTED.has(run.status)) return { verified: run.status, runId: run.runId ?? run.id };
    if (waited >= VERIFY_MAX) return { verified: run?.status ?? "not-started" };
    await sleep(VERIFY_STEP);
  }
}

export function reportOf(snap, decisions, { tier, tierReason = tierReasonOf(snap, tier, false), dispatch = null }) {
  const lines = [`## 巡检 ${snap.generatedAt}`, "", `档位：${tier}（${tierReason}）｜分诊：${snap.triage?.full ? `全量（${snap.triage.reason}）` : "增量"}`];
  for (const e of snap.environments ?? []) {
    lines.push("", `### ${e.alias ?? e.label}`);
    if (e.error) { lines.push(`- 不可读：${e.error}`); continue; }
    for (const d of decisions.filter((x) => x.environmentId === e.environmentId)) {
      const results = (d.results ?? []).map((r) => (r.ok ? r.verified ?? "ok" : `失败：${r.error}`)).join("，");
      lines.push(`- ${d.link ?? d.threadId} ${d.title ?? ""}：${d.summary}${results ? `｜${results}` : ""}`);
    }
    const quiet = (e.candidates ?? []).filter((c) => c.triage === "quiet");
    if (quiet.length) lines.push(`- 静默 ${quiet.length} 个：${quiet.map((c) => c.title).join("、")}`);
    const k = e.checks ?? {};
    lines.push(`- 例行复核：失败 ${k.failedThreads ?? "未知"}，缺监听 ${k.needsWatchThreads ?? "未知"}，命名 ${k.needsRenameThreads ?? "未知"}，久审 ${k.convergenceAuditThreads ?? "未知"}，巡检排除 ${k.patrolExcluded ?? "未知"}；容量 ${poolText(e.capacity) || "未知"}`);
  }
  for (const u of snap.unreachable ?? []) lines.push("", `### ${u.alias ?? u.label}`, `- 不可达：${u.error ?? u.status}`);
  if (dispatch) {
    lines.push("", "### 本轮派活");
    if (dispatch.skipped) lines.push(`- 未派：${dispatch.skipped}`);
    for (const h of dispatch.handoffs ?? []) lines.push(`- 交接 ${h.source} → ${h.target ?? "—"}：${h.link ?? h.blocked ?? h.error ?? ""}`);
    for (const l of dispatch.launched ?? []) lines.push(`- ${l.ref ?? l.title} → ${l.device}：${l.link ?? ""}${l.pending ? "（工作树准备中）" : ""}${l.error ? `失败：${l.error}` : ""}${l.planned ? "（dry-run 未执行）" : ""}`);
    for (const d of dispatch.dropped ?? []) lines.push(`- 移出题库 ${d.ref}：${d.reason}`);
    for (const d of dispatch.recheck ?? []) lines.push(`- 转重核 ${d.ref}：${d.reason}`);
    for (const i of dispatch.idle ?? []) lines.push(`- 空位 ${i.device}/${i.pool} 余 ${i.free}：${i.reason ?? "题库无适配题目，补货中"}`);
  }
  const ask = decisions.filter((d) => d.needsUser);
  const blocked = decisions.filter((d) => d.blocker || (d.results ?? []).some((r) => !r.ok));
  if (ask.length) lines.push("", "### 需要你决定", ...ask.map((d) => `- ${d.link ?? d.threadId}：${d.needsUser}`));
  if (blocked.length) lines.push("", "### 阻塞", ...blocked.map((d) => `- ${d.link ?? d.threadId}：${d.blocker ?? (d.results ?? []).filter((r) => !r.ok).map((r) => r.error).join("；")}`));
  return `${lines.join("\n")}\n`;
}

async function dispatchStatus(snap, dir) {
  const { loadConfig } = await import(join(DISPATCH, "dispatch-config.mjs"));
  const { config, errors, warnings } = loadConfig();
  if (errors.length) return { enabled: false, reason: errors.join("；") };
  const { existsSync } = await import("node:fs");
  const { configDir } = await import("./patrol-config.mjs");
  if (config.mode === "off" || !config.repos.length) return { enabled: false, reason: config.mode === "off" ? "mode 为 off" : "repos 为空" };
  if (existsSync(join(configDir(), "PAUSE"))) return { enabled: false, reason: "PAUSE 存在" };
  const { slotsOf } = await import(join(DISPATCH, "dispatch-queue.mjs"));
  const free = [...slotsOf(snap).values()].filter((s) => s.free > 0).map((s) => ({ device: s.alias, pool: s.pool, free: s.free }));
  const { refillPlan } = await import(join(DISPATCH, "dispatch-plan.mjs"));
  try {
    const plan = await refillPlan({ capacity: snap, briefDir: join(dir, "refill"), connected: true });
    return {
      enabled: true, mode: config.mode, free, ...(warnings.length ? { warnings } : {}),
      refill: plan.refill.map((r) => ({ repo: r.repo, stock: r.stock, target: r.target, deficit: r.deficit, ...(plan.briefs?.[r.repo] ? { brief: plan.briefs[r.repo] } : {}), ...(r.unknownDevices ? { unknownDevices: r.unknownDevices } : {}) })),
      ...(plan.warnings ? { refillWarnings: plan.warnings } : {}),
    };
  } catch (e) {
    return { enabled: true, mode: config.mode, free, refillError: e.message };
  }
}

const readJson = (f) => JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = opt("dir") ?? "/tmp/t3-patrol";
  const decisionsFile = join(dir, "decisions.json");
  try {
    if (cmd === "start") {
      const self = opt("self");
      if (!self) throw new Error("start 需要 --self <本线程 id>");
      mkdirSync(dir, { recursive: true });
      const s = spawnSync(process.execPath, [join(SCRIPTS, "patrol-snapshot.mjs"), "--self", self], { encoding: "utf8", maxBuffer: 1 << 28 });
      if (s.status !== 0) {
        console.error(s.stderr);
        process.exit(s.status === 2 ? 2 : 1);
      }
      writeFileSync(join(dir, "snapshot.json"), s.stdout);
      const snap = JSON.parse(s.stdout);
      await connect("t3-patrol-round");
      const watch = await watchAll(snap);
      const batches = judgeBatches(snap, { size: snap.config?.subagents?.judgeBatch ?? 4 });
      batches.forEach((b, i) => writeFileSync(join(dir, `judge-${i + 1}.json`), `${JSON.stringify(judgeInput(snap, b, { out: join(dir, `judge-${i + 1}.out.json`) }), null, 1)}\n`));
      const dispatch = await dispatchStatus(snap, dir);
      console.log(JSON.stringify(packOf(snap, { dir, batches, watch, dispatch }), null, 1));
    } else if (cmd === "review") {
      const files = args.filter((a) => !a.startsWith("--") && a !== opt("dir"));
      const decisions = mergeDecisions(files.map(readJson));
      writeFileSync(decisionsFile, `${JSON.stringify(decisions, null, 1)}\n`);
      console.log([`${decisions.length} 条 → ${decisionsFile}`, ...decisions.map(reviewLine)].join("\n"));
    } else if (cmd === "run") {
      if (!hasSession()) throw new Error(NO_SESSION);
      const decisions = readJson(decisionsFile);
      const state = loadState();
      for (const d of decisions) {
        if (d.handoff && !d.handoffDone) putHandoff(state, d.handoff);
        if (d.handoffResolve && !d.handoffDone) resolveHandoff(state, d.handoffResolve);
        if (d.handoff || d.handoffResolve) d.handoffDone = true;
      }
      saveState(state);
      await connect("t3-patrol-round");
      const fresh = [];
      for (const d of decisions) {
        d.results ??= [];
        for (const [i, c] of (d.calls ?? []).entries()) {
          if (d.results[i]?.ok) continue;
          [d.results[i]] = await runCalls([{ label: `${d.title ?? d.threadId} #${i}`, ...c }]);
          fresh.push([d.results[i], c]);
        }
      }
      await Promise.all(fresh.map(async ([res, c]) => {
        if (res.ok && c.args?.threadId) Object.assign(res, await verify(c, res.result));
      }));
      writeFileSync(decisionsFile, `${JSON.stringify(decisions, null, 1)}\n`);
      const rows = decisions.flatMap((d) => (d.results ?? []).map((r) => `${d.title ?? d.threadId}｜${r.tool}｜${r.ok ? r.verified : `失败：${r.error}`}`));
      const quota = rows.filter((x) => QUOTA.test(x));
      console.log([...rows, ...(quota.length ? [`疑似额度失败 ${quota.length} 条：finish 带 --quota-failure，按 recovery.md 换档后补救`] : [])].join("\n") || "没有写操作");
      process.exitCode = decisions.some((d) => (d.results ?? []).some((r) => !r.ok)) ? 1 : 0;
    } else if (cmd === "finish") {
      const tier = opt("tier");
      if (!tier) throw new Error("finish 需要 --tier <档位 name>");
      const snap = readJson(join(dir, "snapshot.json"));
      let decisions = [];
      try { decisions = readJson(decisionsFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const state = loadState();
      const alive = new Set((snap.environments ?? []).flatMap((e) => (e.candidates ?? []).map((c) => threadKey(e.environmentId, c.id))));
      recordDecisions(state, decisions, { alive });
      const quotaFailure = args.includes("--quota-failure");
      commitRound(state, snap, { tier, quotaFailure });
      saveState(state);
      const dispatchFile = opt("dispatch");
      process.stdout.write(reportOf(snap, decisions, { tier, tierReason: tierReasonOf(snap, tier, quotaFailure), dispatch: dispatchFile ? readJson(dispatchFile) : null }));
    } else {
      console.error("用法：node patrol-round.mjs start --self <id> | review <judge 输出…> | run | finish --tier <name> [--quota-failure] [--dispatch <文件>]  （均可加 --dir）");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
