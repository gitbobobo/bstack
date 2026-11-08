#!/usr/bin/env node
// 巡检快照：经 T3 MCP 的 HTTP 端点一次性收集所有环境的候选线程与尾部消息，
// 只输出判定需要的字段，避免把 t3_thread_list / t3_thread_read 的原始大 JSON 灌进上下文。
//
// 用法：node patrol-snapshot.mjs [--self <本线程 id>] [--tail 4] [--chars 600] [--capacity-only] [--full]
// --capacity-only 只输出各环境的容量、项目与未 settle 顶层线程标题（派活用），跳过候选详情与 PR 实况。
// --full 强制全量分诊（所有候选按「有事」输出）。
// 依赖 T3 向 harness 进程注入的 MCP 会话（ACP 类与 pi 有，Codex 没有；缺席时退出码 2，改用 MCP 工具手工取证）。

import { existsSync, realpathSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnvironments } from "./patrol-config.mjs";
import { capacityOf } from "./patrol-capacity.mjs";
import { call, connect, hasSession, NO_SESSION, pool } from "./t3-mcp.mjs";
import { configure as configurePr, prLiveOf } from "./pr-live.mjs";
import { loadState } from "./patrol-state.mjs";
import { fullRoundOf, triageOf, WAIT_MARK } from "./patrol-triage.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SELF = opt("self", null);
const TAIL = Number(opt("tail", 4));
const CHARS = Number(opt("chars", 600));
const CONC = Number(opt("concurrency", 6));
const CAPACITY_ONLY = args.includes("--capacity-only");
// 生效的巡检偏好（默认值 + ~/.config/bstack/t3-patrol.json），启动时加载一次。
const PREFS = loadConfig();
const CFG = PREFS.config;
const KNOWN = loadEnvironments();
const ALIAS_OF = new Map(Object.entries(KNOWN.environments).map(([alias, e]) => [e.environmentId, { alias, device: e.device }]));
const DEVICE_OF = new Map(CFG.capacity.devices.map((d) => [KNOWN.environments[d.device]?.environmentId, d]).filter(([id]) => id));
const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STATE = loadState();
const ROUND = args.includes("--full") ? { full: true, reason: "--full" } : fullRoundOf(STATE.lastRound, CFG.triage);
configurePr({ convergenceAudit: CFG.convergenceAudit });

const clip = (s, n = CHARS) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
// 尾部消息保留首尾：代理常在长汇报末尾才提问或说「等你合并」，只截开头会把这句截掉。
const clipEnds = (s, n = CHARS) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const head = Math.floor(n * 0.4);
  return `${t.slice(0, head)} …[略]… ${t.slice(t.length - (n - head))}`;
};
// Fast Ship 发起的审查线程：结论走 Fast Ship 接口提交，失败由 Fast Ship 重派，巡检不接手。
export const isReviewBot = (t) => /^(?:代码|视觉)审查 · PR #\d+/.test(t.title ?? "");
// 探测线程：额度探测（「0. 前提」）由巡检自己建、当轮 settle，不是待判任务（「资源探测」是旧版留下的同类线程），
// 也不占名额；失败本身就是探测结果，不进 failedTopLevel。
export const isProbe = (t) => /^(?:额度|资源)探测$/.test(String(t.title ?? "").trim());
const isSubagent = (t) => t.parentThreadId || t.threadId.startsWith("thread:delegated-task:");
// 代理派活的执行线程：首条消息就是派活模板。它们做完即完成，验收由派活方负责，不该占巡检候选。
// 判据只能用内容，不能用 `mcp:launch:` 前缀——那只是 launch 方式，代理也会用它建长期验收/总单线程。
// 有工作树的一律留下：那说明它绑着一段真实工作，被过滤掉就再没人看得见它。
const isDelegatedTask = (task, hasWorktree) =>
  !hasWorktree && /^\s*(Act as|你是|作为).{0,80}(sub-?agent|子代理|审查者|审查代理)/i.test(String(task ?? ""));

async function listAll(environmentId) {
  const out = [];
  let cursor = 0;
  for (;;) {
    // 不带 includeSubagents:false 时列表含全部未 settle 的子代理线程（本机常有上百条），多翻页且每页慢上一倍。
    const args = { allProjects: true, settled: false, includeSubagents: false, limit: 100, cursor, ...(environmentId ? { environmentId } : {}) };
    // 列表偶发 orchestration_error，重试一次；整个环境因一次抖动缺席代价太大。
    const page = await call("t3_thread_list", args).catch(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return call("t3_thread_list", args);
    });
    out.push(...page.threads);
    if (page.nextCursor == null) return out;
    cursor = page.nextCursor;
  }
}

async function listProjects(environmentId) {
  const out = new Map();
  let cursor = 0;
  for (;;) {
    const page = await call("t3_project_list", { limit: 100, cursor, ...(environmentId ? { environmentId } : {}) });
    for (const p of page.projects) out.set(p.id, p.repositoryIdentity ?? null);
    if (page.nextCursor == null) return out;
    cursor = page.nextCursor;
  }
}

// 只量本机 T3 工作树所在盘（零成本的保底闸）；远程磁盘由在那里干活的线程自己查，不足时留 WAIT_MARK。
function localDiskFreeGB() {
  try {
    const root = join(process.env.T3CODE_HOME || join(homedir(), ".t3"), "worktrees");
    const st = statfsSync(existsSync(root) ? root : homedir());
    return Math.round(((st.bavail * st.bsize) / 1e9) * 10) / 10;
  } catch {
    return null;
  }
}

// 最后一条消息是代理留下的「等待资源」标记且线程已停：返回 { at, line }。
function waitOf(status, lastMsg) {
  if (LIVE.has(status) || !lastMsg || lastMsg.type !== "assistant_message") return null;
  const text = String(lastMsg.text ?? "").trimStart();
  return text.startsWith(WAIT_MARK) ? { at: lastMsg.updatedAt, line: clip(text.split("\n")[0], 200) } : null;
}

// --capacity-only 不读尾部，只为停着的线程补读最后一条消息，认出等资源的线程。
async function waitingOf(scope, t) {
  if (LIVE.has(t.status) || isProbe(t) || isReviewBot(t)) return null;
  const r = await call("t3_thread_read", { threadId: t.threadId, afterPosition: Math.max(0, (t.itemCount ?? 0) - 20), limit: 50, maxCharsPerItem: 400, ...scope }).catch(() => null);
  const last = (r?.items ?? []).filter((i) => i.type === "user_message" || i.type === "assistant_message").at(-1);
  return waitOf(t.status, last);
}

async function tailOf(environmentId, t) {
  const env = environmentId ? { environmentId } : {};
  // 读首条用户消息（任务原文）与尾部若干条消息；只留 user/assistant 文本。
  const head = await call("t3_thread_read", { threadId: t.threadId, limit: 1, maxCharsPerItem: CHARS, ...env });
  // 尾部窗口里可能全是工具调用而没有消息（默认视图只回消息），窗口逐级放大到读到为止。
  let meta = head;
  let msgs = [];
  for (const back of [40, 200, 1000]) {
    let after = Math.max(0, (t.itemCount ?? 0) - back);
    const items = [];
    for (let guard = 0; guard < 20; guard++) {
      const r = await call("t3_thread_read", { threadId: t.threadId, afterPosition: after, limit: 50, maxCharsPerItem: 20000, ...env });
      meta = r;
      items.push(...r.items);
      if (!r.hasMore || r.nextPosition == null) break;
      after = r.nextPosition;
    }
    msgs = items.filter((i) => i.type === "user_message" || i.type === "assistant_message");
    if (msgs.length >= TAIL || after === 0) break;
  }
  const first = head.items.find((i) => i.type === "user_message");
  const lastMsgAt = Date.parse(msgs.at(-1)?.updatedAt ?? "") || null;
  return {
    ...(LIVE.has(t.status) ? await spinOf(environmentId, t, lastMsgAt) : {}),
    // t3_thread_list 不带 worktreePath，只有 t3_thread_read 的 thread 有。
    hasWorktree: Boolean(head.thread?.worktreePath),
    task: clip(first?.text, 300),
    pendingRequestCount: meta.thread?.pendingRequestCount ?? 0,
    lastRunEndedAt: (meta.recentRuns ?? []).map((r) => r.completedAt ?? r.startedAt ?? r.requestedAt).filter(Boolean).sort().at(-1) ?? null,
    runs: (meta.recentRuns ?? []).slice(0, 3).map((r) => `${r.ordinal}:${r.status}${r.startedAt ? "" : "(未启动)"}@${r.completedAt ?? r.startedAt ?? r.requestedAt}`),
    waitingResources: waitOf(t.status, msgs.at(-1)),
    tail: msgs.slice(-TAIL).map((i) => `[${i.updatedAt?.slice(5, 16)} ${i.type === "user_message" ? (i.createdBy === "user" ? "用户" : "注入") : "代理"}] ${clipEnds(i.text)}`),
    lastMsgAt: msgs.at(-1)?.updatedAt ?? null,
  };
}

// 在跑线程的空转迹象：最近 30 个工具调用里有几种不同命令、距最后一条消息多少分钟。
// 退化循环会反复执行同一类命令，只看消息尾部时它和正常干活没有区别。
async function spinOf(environmentId, t, lastMsgAt) {
  const env = environmentId ? { environmentId } : {};
  const r = await call("t3_thread_read", { threadId: t.threadId, view: "activity", afterPosition: Math.max(0, (t.itemCount ?? 0) - 40), limit: 60, maxCharsPerItem: 200, ...env });
  const calls = r.items.filter((i) => i.type === "command_execution" || i.type === "dynamic_tool").slice(-30);
  const norm = (i) => String(i.text ?? i.title ?? "").replace(/\s+/g, " ").slice(0, 120);
  return {
    recentToolCalls: calls.length,
    distinctRecentCommands: new Set(calls.map(norm)).size,
    sampleCommand: calls.length ? clip(norm(calls.at(-1)), 160) : null,
    minutesSinceLastMessage: lastMsgAt ? Math.round((Date.now() - lastMsgAt) / 60000) : null,
  };
}

// 监听体检：open PR 却不再监听的，事件到了也不会唤醒它。线程收轮时 unwatch 是常态，
// 靠人眼在摘要里交叉判定会漏（PR #687 就是这么漏的），所以显式算成字段；
// 正在跑的也算（代挂不改变线程状态，提前挂上避免它收轮后掉进没人唤醒的窗口）。
function needsWatchOf(prs) {
  const unwatched = (prs ?? []).filter((p) => p.includes(":open(unwatched)"));
  return unwatched.length ? { needsWatch: true, needsWatchPrs: unwatched } : { needsWatch: false };
}

// 命名体检：标题是侧栏里唯一的识别入口。三类必须改：原文堆砌（raw）、超宽（wide，>20 个汉字，ASCII 算半个）、
// 有 open PR 却没带号（stale-id）。算成字段而不是靠巡检记得去看——靠记得的那一步漏过好几天。
const titleWidth = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 0.5 : 1), 0);
export function renameOf(title, prs) {
  const t = String(title ?? "");
  const reasons = [];
  if (/\/t3-orchestrator|Act as|## |\n/.test(t)) reasons.push("raw");
  if (titleWidth(t.trim()) > 20) reasons.push("wide");
  const openNums = (prs ?? []).filter((p) => /:open\b/.test(p)).map((p) => p.match(/#(\d+):/)?.[1]).filter(Boolean);
  if (openNums.length && !openNums.some((n) => new RegExp(`#${n}(?!\\d)`).test(t))) reasons.push("stale-id");
  return reasons.length ? { needsRename: true, renameReasons: reasons } : { needsRename: false };
}

// 久审未收敛：开放时长或轮次越线、且 24 小时内还有 P0–P2 行内意见。
// 这类线程看起来最健康（一直在跑、一直有新结论），却正是最该发预算收口的。
function convergenceOf(health) {
  const hit = (health ?? []).filter((h) => h?.needsConvergenceAudit);
  if (!hit.length) return { needsConvergenceAudit: false };
  return {
    needsConvergenceAudit: true,
    convergenceAuditPrs: hit.map((h) => `#${h.num}(${h.openHours}h/${h.reviewRounds ?? "?"}轮/${h.inlineP0P2}条P0-P2@24h/${h.repo})`),
  };
}

// 占用名额的线程：有活跃 run 或有子代理在跑的（含 Fast Ship 审查线程），或 PR 仍 open、最近 2 小时内跑过的（两轮审查之间
// 线程会暂时 completed，但工作树和编译资源还占着）。PR 已合并/关闭、没有 PR 又没在跑的线程不占名额。
// 不用 updatedAt：同步会批量刷新它。
const holdsOpenPr = (t) => !LIVE.has(t.status) && !isProbe(t) && (t.pullRequests ?? []).some((p) => p.state === "open");

// 父线程把活交给子代理后，自己的 run 会 completed，等子代理完成时唤醒；工作树仍在被子代理改写、编译，按占用算。
async function liveSubagentRoots(environmentId, top) {
  const scope = environmentId ? { environmentId } : {};
  const parentOf = new Map();
  for (let cursor = 0; ; ) {
    const page = await call("t3_thread_list", { allProjects: true, includeSubagents: true, statuses: [...LIVE], limit: 100, cursor, ...scope });
    for (const t of page.threads) if (t.parentThreadId) parentOf.set(t.threadId, t.parentThreadId);
    if (page.nextCursor == null) break;
    cursor = page.nextCursor;
  }
  const topIds = new Set(top.map((t) => t.threadId));
  const roots = new Set();
  for (const id of [...parentOf.keys()]) {
    let cur = parentOf.get(id);
    // 中间层子代理可能已 completed、不在活跃列表里，逐层回读找顶层。
    for (let depth = 0; depth < 6 && cur && !topIds.has(cur); depth++) {
      if (!parentOf.has(cur)) {
        const r = await call("t3_thread_read", { threadId: cur, limit: 1, maxCharsPerItem: 1, ...scope }).catch(() => null);
        parentOf.set(cur, r?.thread?.parentThreadId ?? null);
      }
      cur = parentOf.get(cur);
    }
    if (cur && topIds.has(cur)) roots.add(cur);
  }
  return roots;
}

// rootsP 是提前发起的 liveSubagentRoots：它要列全部活跃子代理，较慢，与候选取证并行。
// waiting：本设备上在等资源的线程标题，非空时这台设备不建新线程。
async function occupancyOf(env, top, lastRunEndedOf, now, rootsP, waiting) {
  const roots = await rootsP;
  const occupying = top.filter((t) => {
    if (isProbe(t)) return false;
    if (LIVE.has(t.status) || roots.has(t.threadId)) return true;
    if (!holdsOpenPr(t)) return false;
    const ended = Date.parse(lastRunEndedOf(t) ?? "");
    return Number.isFinite(ended) && now - ended < CFG.capacity.occupyWindowHours * 3600 * 1000;
  });
  // 池按仓库身份归类；项目清单取不到时只给设备总数，并标 projectsError，免得把全部线程当成「*」池。
  let projects = new Map();
  let projectsError = null;
  try {
    projects = await listProjects(env.isLocal ? null : env.environmentId);
  } catch (e) {
    projectsError = String(e.message ?? e);
  }
  const capacity = {
    ...capacityOf({
      threads: occupying.map((t) => ({ title: clip(t.title, 40), projectId: t.projectId, reviewBot: isReviewBot(t) })),
      projects,
      device: DEVICE_OF.get(env.environmentId),
      cfg: CFG.capacity,
      diskFreeGB: env.isLocal ? localDiskFreeGB() : null,
      waiting,
    }),
    ...(projectsError ? { projectsError } : {}),
  };
  return { occupying, capacity, projects };
}

// --capacity-only：只算容量，供派活使用。只给 PR 仍 open 的已停线程读一次 run 记录、给停着的线程读最后一条消息，不读尾部与 PR 实况。
// 另给项目清单（按仓库找 projectId）与未 settle 顶层线程的标题（按问题编号查重）。
async function capacityEnv(env) {
  const now = Date.now();
  const scope = env.isLocal ? {} : { environmentId: env.environmentId };
  const top = (await listAll(env.isLocal ? null : env.environmentId)).filter((t) => !isSubagent(t));
  const rootsP = liveSubagentRoots(env.isLocal ? null : env.environmentId, top);
  const ended = new Map();
  await pool(top.filter(holdsOpenPr), CONC, async (t) => {
    const r = await call("t3_thread_read", { threadId: t.threadId, limit: 1, maxCharsPerItem: 1, ...scope }).catch(() => null);
    ended.set(t.threadId, (r?.recentRuns ?? []).map((x) => x.completedAt ?? x.startedAt ?? x.requestedAt).filter(Boolean).sort().at(-1) ?? null);
  });
  const waits = await pool(top, CONC, (t) => waitingOf(scope, t));
  const waiting = top.filter((_, i) => waits[i]).map((t) => clip(t.title, 40));
  const { occupying, capacity, projects } = await occupancyOf(env, top, (t) => ended.get(t.threadId), now, rootsP, waiting);
  return {
    environmentId: env.environmentId,
    label: env.label,
    activeTopLevel: occupying.length,
    occupying: occupying.map((t) => clip(t.title, 40)),
    capacity,
    projects: [...projects].map(([id, identity]) => ({ id, canonicalKey: identity?.canonicalKey ?? null })),
    openThreads: top
      .filter((t) => !isProbe(t) && !isReviewBot(t))
      .map((t) => ({ id: t.threadId, link: t.link, title: clip(t.title, 80), status: t.status, projectId: t.projectId, prs: (t.pullRequests ?? []).map((p) => `${p.repository}#${p.number}:${p.state}`) })),
  };
}

const QUIET_FIELDS = ["id", "link", "title", "status", "prs", "lastMsgAt", "lastRunEndedAt", "minutesSinceLastMessage", "distinctRecentCommands", "waitingResources", "triage", "triageReasons"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

async function snapshotEnv(env) {
  const now = Date.now();
  const all = await listAll(env.isLocal ? null : env.environmentId);
  const top = all.filter((t) => !isSubagent(t));
  const rootsP = liveSubagentRoots(env.isLocal ? null : env.environmentId, top);
  const candidates = top.filter((t) => !isReviewBot(t) && !isProbe(t) && t.threadId !== SELF);
  const enriched = await pool(candidates, CONC, async (t) => {      const base = {
        id: t.threadId,
        link: t.link,
        title: clip(t.title, 80),
        createdBy: t.createdBy,
        status: t.status,
        updatedAt: t.updatedAt,
        projectId: t.projectId,
        model: `${t.providerInstanceId}/${t.model}`,
        prs: (t.pullRequests ?? []).map((p) => `${p.repository}#${p.number}:${p.state}${p.watching === false ? "(unwatched)" : ""}`),
      };
      try {
        // watching 状态以 list_thread_pull_requests 为准：t3_thread_list 的快照字段会漏标，
        // 「PR open 但没挂监听」是高频故障，每轮都要显式采。
        const tail = await tailOf(env.isLocal ? null : env.environmentId, t);
        const livePrs = (await call("list_thread_pull_requests", { threadId: t.threadId, ...(env.isLocal ? {} : { environmentId: env.environmentId }) }).catch(() => null))?.pullRequests;
        // 挂了监听的 open PR 仍要对账：订阅存在 ≠ 事件真的唤醒了线程。
        // latestAt 晚于线程最后消息说明有新结论而线程没反应——标 (stale)，按「监听掉了」处理。
        const lastMsgMs = Date.parse(tail.lastMsgAt ?? "") || 0;
        const health = [];
        const unwatchedUrls = [];
        const prs = livePrs
          ? await pool(
              livePrs, CONC, async (p) => {
                let tag = `${p.repository}#${p.number}:${p.state}${p.watching === false ? "(unwatched)" : ""}`;
                if (p.state !== "open") return tag;
                if (p.watching === false && p.url) unwatchedUrls.push(p.url);
                const live = await prLiveOf(tag, p.url);
                if (!live) return tag;
                if (live.unavailable) return `${tag}(health-unavailable)`;
                health.push(live);
                if (p.watching !== false && live.latestAt && Date.parse(live.latestAt) > lastMsgMs) tag += "(stale)";
                return tag;
            })
          : base.prs;
        const prHealth = health.map((h) => ({
          pr: `#${h.num}`,
          host: h.host,
          head: h.head,
          headAt: h.headAt,
          headReview: h.headReview,
          reviewsOnHead: h.reviewsOnHead,
          checks: h.checks,
          lastCommentAt: h.lastCommentAt,
          lastCommentBy: h.lastCommentBy,
          latestAt: h.latestAt,
          failChecks: h.failChecks,
          pendingChecks: h.pendingChecks,
          mergeable: h.mergeable ?? null,
          openHours: h.openHours,
          rounds: h.reviewRounds,
          inline24h: h.inline24h,
          inlineP0P2: h.inlineP0P2,
        }));
        return { ...base, prs, ...tail, ...needsWatchOf(prs), ...(unwatchedUrls.length ? { needsWatchUrls: unwatchedUrls } : {}), ...renameOf(t.title, prs), ...convergenceOf(health), ...(prHealth.length ? { prHealth } : {}) };
      } catch (e) {
        // 取不到详情 ≠ 线程没事：标成 incomplete，报告必须逐条交代（否则会被当成「推进中」）。
        return { ...base, ...renameOf(t.title, base.prs), error: String(e.message ?? e), incomplete: true };
      }
  });
  const byId = new Map(enriched.map((x) => [x.id, x]));
  const waiting = enriched.filter((x) => x.waitingResources).map((x) => clip(x.title, 40));
  const { occupying, capacity } = await occupancyOf(env, top, (t) => byId.get(t.threadId)?.lastRunEndedAt, now, rootsP, waiting);
  const prevUsed = STATE.lastRound?.occupancy?.[env.environmentId];
  const deviceFreed = Number.isInteger(prevUsed) && capacity.used < prevUsed;
  const active = occupying.length;
  const occupyingTitles = occupying.map((t) => clip(t.title, 40));
  const real = enriched
    .filter((x) => !isDelegatedTask(x.task, x.hasWorktree))
    .map((x) => ({ ...x, ...triageOf(x, { since: ROUND.full ? null : ROUND.since, thresholds: CFG.thresholds, now, deviceFreed, resourceWakeHours: CFG.triage.resourceWakeHours }) }));
  // 兜底对账：被任何过滤规则排除、但停在失败态的真实顶层线程。过滤规则一改就可能误杀，
  // 把误杀的线程留在这份名单里，巡检每轮必须逐个过——静默消失比多算几条候选危险得多。
  const realIds = new Set(real.map((x) => x.id));
  const failedTopLevel = top
    .filter((t) => ["failed", "interrupted", "cancelled"].includes(t.status) && !realIds.has(t.threadId) && !isProbe(t))
    .map((t) => ({
      id: t.threadId,
      link: t.link,
      title: clip(t.title, 60),
      status: t.status,
      model: `${t.providerInstanceId}/${t.model}`,
      prs: (t.pullRequests ?? []).map((p) => `${p.repository}#${p.number}:${p.state}`),
      updatedAt: t.updatedAt,
      source: "filtered",
    }));
  // 失败清单同时收候选内与候选外失败线程。判定表只负责动作；这份清单负责「一个都不漏」。
  const failedThreads = [
    ...real
      .filter((x) => ["failed", "interrupted", "cancelled"].includes(x.status))
      .map((x) => ({
        id: x.id,
        link: x.link,
        title: x.title,
        status: x.status,
        model: x.model,
        hasWorktree: x.hasWorktree,
        prs: x.prs,
        runs: x.runs,
        task: x.task,
        tail: x.tail,
        source: "candidates",
      })),
    ...failedTopLevel,
  ];
  // 三项体检各给一份环境级清单，巡检逐条处理、逐条对账，不必再遍历候选找开关。
  const needsWatchThreads = real
    .filter((x) => x.needsWatch)
    .map((x) => ({ id: x.id, link: x.link, prs: x.needsWatchPrs, urls: x.needsWatchUrls ?? [] }));
  const needsRenameThreads = real
    .filter((x) => x.needsRename)
    .map((x) => ({ id: x.id, title: x.title, reasons: x.renameReasons, prs: x.prs, task: x.task, tail: x.tail }));
  const convergenceAuditThreads = real
    .filter((x) => x.needsConvergenceAudit)
    .map((x) => ({ id: x.id, link: x.link, prs: x.convergenceAuditPrs }));
  return {
    environmentId: env.environmentId,
    label: env.label,
    activeTopLevel: active,
    occupying: occupyingTitles,
    capacity,
    // 静默候选只留识别与分诊字段：巡检对它们只记一行，不再深读。
    candidates: real.map((x) => (x.triage === "quiet" ? pick(x, QUIET_FIELDS) : x)),
    delegatedExcluded: enriched.length - real.length,
    failedTopLevel,
    failedThreads,
    needsWatchThreads,
    needsRenameThreads,
    convergenceAuditThreads,
    // 汇报只允许引用这里的计数；从候选摘要或记忆里估数会把漏做的体检写成 0。
    checks: {
      candidates: real.length,
      hot: real.filter((x) => x.triage === "hot").length,
      quiet: real.filter((x) => x.triage === "quiet").length,
      failedThreads: failedThreads.length,
      needsWatchThreads: needsWatchThreads.length,
      needsRenameThreads: needsRenameThreads.length,
      convergenceAuditThreads: convergenceAuditThreads.length,
    },
  };
}

async function main() {
  if (!hasSession()) {
    console.error(NO_SESSION);
    process.exit(2);
  }
  // 以开始时间作快照时间：取证过程中发生的事件留给下一轮的分诊去看见。
  const generatedAt = new Date().toISOString();
  await connect("t3-patrol");
  const links = await call("t3_environment_links", {});
  const envs = [{ environmentId: links.environmentId, label: "本机", isLocal: true }];
  const unreachable = [];
  for (const l of links.links ?? []) {
    if (l.status === "reachable") envs.push({ environmentId: l.environmentId, label: l.label });
    else unreachable.push({ environmentId: l.environmentId, label: l.label, status: l.status, error: l.lastError });
  }
  const results = await pool(
    envs.map((e) => () => (CAPACITY_ONLY ? capacityEnv(e) : snapshotEnv(e)).catch((err) => ({ environmentId: e.environmentId, label: e.label, error: String(err.message ?? err) }))),
    4,
    (run) => run(),
  );
  const { modelLadder, version, ...prefs } = CFG;
  const config = { source: PREFS.source, warnings: PREFS.warnings, errors: PREFS.errors, ...prefs };
  const known = KNOWN;
  const aliasOf = ALIAS_OF;
  for (const d of CFG.capacity.devices) {
    if (!known.environments[d.device]) config.warnings.push(`capacity.devices：设备 ${d.device} 不在 environments.json，它的池本轮不生效`);
  }
  const linked = new Set([...envs, ...unreachable].map((e) => e.environmentId));
  // unlisted/missing 非空说明环境集合与 environments.json 不一致，对照表需要重新认。
  const environmentsFile = {
    source: known.source,
    warnings: known.warnings,
    errors: known.errors,
    unlisted: [...linked].filter((id) => !aliasOf.has(id)),
    missing: Object.keys(known.environments).filter((alias) => !linked.has(known.environments[alias].environmentId)),
  };
  const environments = results.map((r) => ({ ...(aliasOf.get(r.environmentId) ?? {}), ...r }));
  for (const u of unreachable) Object.assign(u, aliasOf.get(u.environmentId) ?? {});
  const triage = CAPACITY_ONLY ? undefined : { full: ROUND.full, ...(ROUND.full ? { reason: ROUND.reason } : { since: ROUND.since }) };
  const lastRound = STATE.lastRound ? { at: STATE.lastRound.at, tier: STATE.lastRound.tier, quotaFailure: STATE.lastRound.quotaFailure } : null;
  console.log(JSON.stringify({ generatedAt, config, modelLadder, lastRound, triage, environmentsFile, unreachable, environments }, null, 1));
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
