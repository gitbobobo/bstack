#!/usr/bin/env node
// 出队派活：按快照的实际空位，先建待交接线程，再按题库顺序弹出 ready 题目建线。主代理不挑题，只跑这一条命令。
//
// 用法：node dispatch-queue.mjs --capacity <快照> [--model-tier <modelLadder 档位 name>] [--dry-run] [--user]
// 快照可以是完整快照或 --capacity-only；--model-tier 缺省用 t3-dispatch 配置的 model，交接线程同用此档。
// --user 表示用户当面要求派活：跳过 mode 与 PAUSE 闸，perRun 仍封顶。
// 顺序：
//   1. 闸：config.mode 为 off、repos 为空或 ~/.config/bstack/PAUSE 存在时不出队；mode 为 dry-run 等同 --dry-run。
//   2. 交接：pendingHandoffs 中带 launch 且未建线的，按 waitingSince 占目标设备同池空位建线，并回写 launchedThreadLink；
//      没有 launch 或没空位的交接占住该池，同池不派新问题；带 needsUser（等用户授权）的不建线也不占池，即使写了 launch。
//   3. 题库：各仓库轮流弹出未过期 ready 条目，设备取条目 devices 与配置 devices 的交集里第一个有空位的；
//      弹出前复核来源：已关闭、出了 PR、离开准入状态或加了暂缓标签的移出题库，正文有更新的改回 pending 待重核，都不占空位。
//   4. 派出复用 dispatch-launch（查重、认领、建线、记账、回读）；派出、已有线程或已被认领的从题库移除。
// 每轮总数受 limits.perRun 与 limits.perDay 余量封顶。
// 输出 { budget, handoffs, launched, dropped, recheck, idle, blocked }：idle 是还有空位但题库没有适配题目的设备池。有失败时退出码 1。

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./dispatch-config.mjs";
import { ledgerSummary, readLedger, run } from "./issue-source.mjs";
import { labelPolicy } from "./dispatch-labels.mjs";
import { applyPatch, readPool, removeIds, stockOf } from "./candidate-pool.mjs";
import { launchConfigFor, launchOne } from "./dispatch-launch.mjs";
import { configDir, loadConfig as loadPatrolConfig, loadEnvironments } from "../../t3-patrol/scripts/patrol-config.mjs";
import { loadState, putHandoff, saveState } from "../../t3-patrol/scripts/patrol-state.mjs";
import { call, connect, hasSession, NO_SESSION } from "../../t3-patrol/scripts/t3-mcp.mjs";

const lower = (s) => String(s ?? "").toLowerCase();

export function slotsOf(capacity) {
  const slots = new Map();
  for (const e of capacity.environments ?? []) {
    if (e.error || !e.capacity) continue;
    for (const p of e.projects ?? []) {
      if (!p.canonicalKey) continue;
      const pool = e.capacity.poolByRepo?.[p.canonicalKey] ?? "general";
      const key = `${e.environmentId}/${pool}`;
      if (!slots.has(key)) slots.set(key, { environmentId: e.environmentId, alias: e.alias ?? e.label, pool, free: e.capacity.freeByRepo?.[p.canonicalKey] ?? 0, used: 0, handoff: false });
    }
  }
  return slots;
}

const slotFor = (capacity, slots, environmentId, repo) => {
  const e = (capacity.environments ?? []).find((x) => x.environmentId === environmentId);
  const project = (e?.projects ?? []).find((p) => lower(p.canonicalKey) === lower(repo));
  if (!project) return null;
  const s = slots.get(`${environmentId}/${e.capacity?.poolByRepo?.[project.canonicalKey] ?? "general"}`);
  return s ? { slot: s, projectId: project.id } : null;
};

// 只决定出队顺序；check(entry, repo) 返回 freshnessOf 结果，不通过的题目不占空位。
export function queuePlan({ capacity, config, environments, pool, ledger, handoffs = [], check = () => ({ ok: true }), now = Date.now() }) {
  const summary = ledgerSummary(ledger, { now });
  const dayLeft = config.limits.perDay > 0 ? Math.max(0, config.limits.perDay - summary.launched) : Infinity;
  let budget = Math.min(config.limits.perRun, dayLeft);
  const slots = slotsOf(capacity);
  const handoffPlan = [];
  for (const h of [...handoffs].filter((x) => !x.launchedThreadLink).sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince))) {
    if (h.needsUser) {
      handoffPlan.push({ handoff: h, blocked: `等你授权：${h.needsUser}` });
      continue;
    }
    const hit = slotFor(capacity, slots, h.targetEnvironmentId, h.canonicalKey);
    if (!hit) {
      handoffPlan.push({ handoff: h, blocked: "目标环境不可达或没有该仓库项目" });
      continue;
    }
    hit.slot.handoff = true;
    if (h.launch && hit.slot.free - hit.slot.used > 0) {
      hit.slot.used++;
      handoffPlan.push({ handoff: h, slot: hit.slot });
    } else handoffPlan.push({ handoff: h, blocked: h.launch ? `${hit.slot.alias}/${hit.slot.pool} 没有空位` : "未写 launch：研判确认可执行后补" });
  }
  const active = new Set(summary.active.map((e) => e.id));
  const queues = config.repos.map((r) => {
    const allowed = r.devices?.length ? new Set(r.devices) : null;
    return { repo: r.repo, allowed, entries: stockOf(pool.repos?.[r.repo] ?? [], { now, maxAgeHours: config.stock?.maxAgeHours }).filter((e) => !active.has(e.id)) };
  });
  const picks = [];
  const dropped = [];
  const recheck = [];
  for (let progress = true; budget > 0 && progress;) {
    progress = false;
    for (const q of queues) {
      if (budget <= 0) break;
      let e;
      while (!e) {
        const i = q.entries.findIndex((x) => x.devices.some((alias) => fits(alias, q)));
        if (i < 0) break;
        const [x] = q.entries.splice(i, 1);
        const v = check(x, q.repo);
        if (v.ok) e = x;
        else (v.drop ? dropped : recheck).push({ repo: q.repo, id: x.id, ref: x.ref, reason: v.drop ?? v.recheck ?? v.error });
      }
      if (!e) continue;
      const alias = e.devices.find((a) => fits(a, q));
      const hit = slotFor(capacity, slots, environments[alias].environmentId, q.repo);
      hit.slot.used++;
      budget--;
      progress = true;
      picks.push({ repo: q.repo, entry: e, alias, environmentId: hit.slot.environmentId, projectId: hit.projectId, slot: hit.slot });
    }
  }
  function fits(alias, q) {
    if (q.allowed && !q.allowed.has(alias)) return false;
    const id = environments[alias]?.environmentId;
    const hit = id && slotFor(capacity, slots, id, q.repo);
    return !!hit && !hit.slot.handoff && hit.slot.free - hit.slot.used > 0;
  }
  return { budget: Math.min(config.limits.perRun, dayLeft), handoffPlan, picks, dropped, recheck, slots: [...slots.values()] };
}

// 弹出前复核：只看来源的准入事实，源码与设备由补货时的研判负责。
export function freshnessOf(entry, issue, repoCfg) {
  if (issue.state && issue.state !== "open") return { drop: `问题已 ${issue.state}` };
  if (issue.prs > 0 || issue.pullRequests?.length) return { drop: "问题已关联 PR" };
  if (repoCfg.statuses && issue.status && !repoCfg.statuses.includes(issue.status)) return { drop: `状态已变为 ${issue.status}` };
  if (labelPolicy(issue.labels).deferred) return { drop: "加了 bstack:defer" };
  if (!entry.issueUpdatedAt || Date.parse(entry.issueUpdatedAt) !== Date.parse(issue.updatedAt)) return { recheck: `来源在 ${issue.updatedAt} 有更新` };
  return { ok: true };
}

export const launchOf = (p) => ({
  repo: p.repo,
  ids: [p.entry.id, ...(p.entry.mergeIds ?? [])],
  environmentId: p.environmentId,
  projectId: p.projectId,
  title: p.entry.threadTitle ?? `${p.entry.ref} ${p.entry.title}`.slice(0, 30),
  reason: `${p.entry.reason}\n范围：${p.entry.scope}`,
});

// 已建线、已有线程在做或已被别人认领的题目不再留在题库。
export const consumed = (r) => !!(r.threadId || r.duplicate || /主问题认领失败/.test(r.error ?? ""));

const threadLink = (environmentId, threadId) => `t3-thread://v2/${environmentId}/${threadId}`;

async function launchHandoff(h, modelSelection, config) {
  const repoCfg = config.repos.find((r) => r.repo === lower(h.canonicalKey));
  const r = await call("t3_thread_launch", {
    environmentId: h.targetEnvironmentId,
    projectId: h.launch.projectId,
    title: h.launch.title,
    modelSelection,
    runtimeMode: config.runtimeMode,
    workspaceStrategy: { type: "worktree", baseRef: repoCfg?.baseRef ?? "main", startFromOrigin: true },
    message: h.launch.message,
    clientRequestId: `t3-patrol-handoff-${h.sourceThreadId}`,
  });
  return { threadId: r.threadId, link: r.link };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const file = opt("capacity");
    if (!file) {
      console.error("用法：node dispatch-queue.mjs --capacity <快照> [--model-tier <name>] [--dry-run] [--user]");
      process.exit(2);
    }
    const { config, errors } = loadConfig();
    if (errors.length) throw new Error(errors.join("；"));
    const user = args.includes("--user");
    const gate = user ? null : config.mode === "off" ? "mode 为 off" : !config.repos.length ? "repos 为空" : existsSync(join(configDir(), "PAUSE")) ? "PAUSE 存在" : null;
    if (gate) {
      console.log(JSON.stringify({ skipped: gate }));
      process.exit(0);
    }
    const dryRun = args.includes("--dry-run") || (!user && config.mode === "dry-run");
    const tier = opt("model-tier");
    let modelSelection = config.model;
    if (tier) {
      const t = loadPatrolConfig().config.modelLadder.find((x) => x.name === tier);
      if (!t) throw new Error(`modelLadder 里没有档位 ${tier}`);
      modelSelection = { instanceId: t.instanceId, model: t.model, ...(t.options ? { options: t.options } : {}) };
    }
    const capacity = JSON.parse(readFileSync(file, "utf8"));
    const environments = loadEnvironments().environments;
    const state = loadState();
    const check = (entry, repo) => {
      try { return freshnessOf(entry, run("show", { repo, id: entry.id }), config.repos.find((r) => r.repo === repo)); }
      catch (e) { return { error: `来源复核失败：${e.message}` }; }
    };
    const plan = queuePlan({ capacity, config, environments, pool: readPool().state, ledger: readLedger(), handoffs: state.pendingHandoffs, check });
    const out = { budget: plan.budget, dryRun, modelSelection, handoffs: [], launched: [], dropped: plan.dropped, recheck: plan.recheck };
    for (const x of plan.handoffPlan) out.handoffs.push({ source: x.handoff.sourceLink, target: x.slot ? `${x.slot.alias}/${x.slot.pool}` : null, ...(x.blocked ? { blocked: x.blocked } : {}) });
    const launches = plan.picks;
    if (dryRun) {
      out.launched = launches.map((p) => ({ ...launchOf(p), device: p.alias, planned: true }));
    } else {
      if (!hasSession()) throw new Error(NO_SESSION);
      await connect("t3-dispatch-queue");
      let dirty = false;
      for (const x of plan.handoffPlan.filter((y) => y.slot)) {
        const row = out.handoffs.find((r) => r.source === x.handoff.sourceLink);
        try {
          const r = await launchHandoff(x.handoff, modelSelection, config);
          putHandoff(state, { ...x.handoff, launchedThreadLink: threadLink(x.handoff.targetEnvironmentId, r.threadId) });
          dirty = true;
          Object.assign(row, r);
        } catch (e) {
          row.error = `交接建线失败：${e.message}`;
          x.slot.used--;
        }
      }
      if (dirty) saveState(state);
      const dir = mkdtempSync(join(tmpdir(), "t3-dispatch-"));
      try {
        const cfg = launchConfigFor({ modelSelection }, config);
        for (const p of launches) out.launched.push({ device: p.alias, ref: p.entry.ref, ...(await launchOne(launchOf(p), cfg, dir)) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const byRepo = new Map();
      for (const [i, r] of out.launched.entries()) if (consumed(r)) byRepo.set(launches[i].repo, [...(byRepo.get(launches[i].repo) ?? []), ...r.ids]);
      for (const d of out.dropped) byRepo.set(d.repo, [...(byRepo.get(d.repo) ?? []), d.id]);
      for (const [repo, ids] of byRepo) removeIds({ repo, ids });
      for (const r of out.recheck.filter((x) => !/复核失败/.test(x.reason))) {
        const { revision, state: poolState } = readPool();
        const e = (poolState.repos[r.repo] ?? []).find((x) => x.id === r.id);
        if (e) applyPatch({ repo: r.repo, patch: { revision, remove: [], upsert: [{ ...e, state: "pending", deferredBy: "evidence", nextCheck: `${r.reason}，重读正文与共识后重判准入` }] } });
      }
    }
    out.idle = plan.slots.filter((s) => s.free - s.used > 0).map((s) => ({ device: s.alias, pool: s.pool, free: s.free - s.used, ...(s.handoff ? { reason: "交接占池" } : {}) }));
    console.log(JSON.stringify(out, null, 1));
    process.exitCode = out.launched.some((r) => r.error) || out.handoffs.some((h) => h.error) ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
