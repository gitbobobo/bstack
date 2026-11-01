#!/usr/bin/env node
// 巡检快照：经 T3 MCP 的 HTTP 端点一次性收集所有环境的候选线程与尾部消息，
// 只输出判定需要的字段，避免把 t3_thread_list / t3_thread_read 的原始大 JSON 灌进上下文。
//
// 用法：node patrol-snapshot.mjs [--self <本线程 id>] [--tail 4] [--chars 600]
// 依赖环境变量 T3_MCP_URL、T3_MCP_BEARER_TOKEN（T3 注入；缺席时退出码 2，改用 MCP 工具手工取证）。

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SELF = opt("self", null);
const TAIL = Number(opt("tail", 4));
const CHARS = Number(opt("chars", 600));
const ACTIVE_MS = 2 * 3600 * 1000; // 有在审 PR 的线程，最近一次 run 结束多久内仍算占用
const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const DEBUG = !!process.env.T3_PATROL_DEBUG;

const URL_ = process.env.T3_MCP_URL;
const TOKEN = process.env.T3_MCP_BEARER_TOKEN;

let sid = null;
let seq = 0;
async function rpc(method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
  };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  sid = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  const m = text.match(/^data: (.*)$/m);
  const msg = JSON.parse(m ? m[1] : text);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? "error"}`);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

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
const isReviewBot = (t) => /^代码审查 · PR #\d+/.test(t.title);
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
    const page = await call("t3_thread_list", { allProjects: true, settled: false, limit: 100, cursor, ...(environmentId ? { environmentId } : {}) });
    out.push(...page.threads);
    if (page.nextCursor == null) return out;
    cursor = page.nextCursor;
  }
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
    task: clip(first?.text, 300),
    pendingRequestCount: meta.thread?.pendingRequestCount ?? 0,
    lastRunEndedAt: (meta.recentRuns ?? []).map((r) => r.completedAt ?? r.startedAt ?? r.requestedAt).filter(Boolean).sort().at(-1) ?? null,
    runs: (meta.recentRuns ?? []).slice(0, 3).map((r) => `${r.ordinal}:${r.status}${r.startedAt ? "" : "(未启动)"}@${r.completedAt ?? r.startedAt ?? r.requestedAt}`),
    tail: msgs.slice(-TAIL).map((i) => `[${i.updatedAt?.slice(5, 16)} ${i.type === "user_message" ? (i.createdBy === "user" ? "用户" : "注入") : "代理"}] ${clipEnds(i.text)}`),
    lastMsgAt: msgs.at(-1)?.updatedAt ?? null,
  };
}

// PR 实况：open PR 的最新 review 时间、失败检查，以及“审了多久 / 多少轮 / 今天还在冒意见”这组收敛信号。
// watching=true 只代表订阅存在，不代表事件真的唤醒了线程——必须拿 PR 最新结论时间和线程最后消息对账，
// 才能发现「挂了监听但事件没投递到/投递后线程没醒」的漏唤醒。
// 轮次/时长/当日行内意见过去全靠每轮现算，结果是不算（线程看起来一直在动就当成健康），
// 久审不收敛的线程因此从未被审计过——这里算成字段，让异常自己冒出来。
const ROUNDS_JQ =
  '{createdAt, review:(.reviews|last|.submittedAt), comment:(.comments|last|.createdAt),' +
  ' rounds:([((.reviews[]?.body // ""), (.comments[]?.body // "")) | try (capture("第\\\\s*(?<n>[0-9]+)\\\\s*轮").n) catch null, try (capture("[Rr]ound\\\\s*(?<n>[0-9]+)").n) catch null] | map(select(. != null) | tonumber) | max),' +
  ' failChecks:[.statusCheckRollup[]|select(.conclusion=="FAILURE")|.name], pendingChecks:[.statusCheckRollup[]|select(.conclusion=="")|.name]|length}';

// ---- PR 实况：github.com 走 gh，其他宿主（Forgejo/Gitea）走 REST。 ----
// 只走 gh 会让搬去 Forgejo 的仓库静默失明：prLiveOf 返回 null，(stale)、久审不收敛、
// PR 健康度全都不触发，而 PR 可能已经三十几轮还在冒 P2——正是这张表要拦的那种。
let liveCache = new Map();

const roundOf = (texts) => {
  let n = null;
  for (const t of texts) {
    for (const re of [/第\s*(\d+)\s*轮/, /[Rr]ound\s*(\d+)/]) {
      const m = String(t ?? "").match(re);
      if (m) n = Math.max(n ?? 0, Number(m[1]));
    }
  }
  return n;
};
const P02 = /\bP[0-2]\b/;
const NEED_AUDIT = (openHours, reviewRounds, inlineP0P2) =>
  Boolean(((openHours ?? 0) > 48 || (reviewRounds ?? 0) > 20) && (inlineP0P2 ?? 0) > 0);

// 端点地址与凭据：环境变量 → ~/.agents/env/forgejo.sh → 本地工作树的 origin + git credential helper。
function forgeConf() {
  const bases = [];
  const tokens = [];
  for (const k of ["FORGEJO_BASE", "FORGEJO_URL", "GITEA_URL"]) if (process.env[k]) bases.push(process.env[k]);
  for (const k of ["FORGEJO_TOKEN", "GITEA_TOKEN", "FORGEJO_API_TOKEN"]) if (process.env[k]) tokens.push(process.env[k]);
  try {
    for (const line of readFileSync(join(homedir(), ".agents", "env", "forgejo.sh"), "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)=(.*)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (/^(FORGEJO|GITEA)_(BASE|URL|HOST)$/i.test(m[1]) && /^https?:\/\//.test(val)) bases.push(val);
      else if (/^(FORGEJO|GITEA)_?.*TOKEN/i.test(m[1]) && val) tokens.push(val);
    }
  } catch {}
  return {
    bases: [...new Set(bases.map((b) => b.replace(/\/+$/, "")).filter(Boolean))],
    tokens: [...new Set(tokens.filter(Boolean))],
  };
}

async function baseFromHint(hint) {
  if (!hint) return null;
  // PR 自己的 URL 最可靠：T3 记录的 pullRequests[].url 就带宿主，工作树收尾后已回收也不影响。
  try {
    const host = new URL(String(hint)).origin;
    if (/^https?:/.test(host)) return host;
  } catch {}
  try {
    const { execFileSync } = await import("node:child_process");
    const url = execFileSync("git", ["-C", hint, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    const m = url.match(/^(https?):\/\/([^/]+)/);
    return m ? `${m[1]}://${m[2]}` : null;
  } catch {
    return null;
  }
}

async function credentialFor(base) {
  try {
    const { execFileSync } = await import("node:child_process");
    const u = new URL(base);
    const out = execFileSync("git", ["credential", "fill"], {
      input: `protocol=${u.protocol.replace(":", "")}\nhost=${u.host}\n\n`,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const hit = out.split("\n").find((l) => l.startsWith("password="));
    return hit ? hit.slice("password=".length) : null;
  } catch {
    return null;
  }
}

async function forgeApi(base, token, path) {
  const res = await fetch(`${base}/api/v1${path}`, {
    headers: { authorization: `token ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function forgejoLiveOf(repo, num, hint) {
  const conf = forgeConf();
  const bases = [];
  const fromWt = await baseFromHint(hint);
  if (fromWt) bases.push(fromWt);
  for (const b of conf.bases) if (!bases.includes(b)) bases.push(b);
  for (const base of bases) {
    const tokens = [...conf.tokens];
    const fromGit = await credentialFor(base);
    if (fromGit) tokens.push(fromGit);
    for (const token of [...new Set(tokens)]) {
      try {
        const pr = await forgeApi(base, token, `/repos/${repo}/pulls/${num}`);
        const reviews = (await forgeApi(base, token, `/repos/${repo}/pulls/${num}/reviews?limit=50`).catch(() => [])) ?? [];
        const comments = (await forgeApi(base, token, `/repos/${repo}/issues/${num}/comments?limit=100`).catch(() => [])) ?? [];
        const statuses = (await forgeApi(base, token, `/repos/${repo}/commits/${pr.head?.sha}/statuses?limit=50`).catch(() => [])) ?? [];
        const sinceMs = Date.now() - 24 * 3600 * 1000;
        let inline24h = 0;
        let inlineP0P2 = 0;
        let latest = 0;
        for (const r of reviews.slice(-12)) {
          const at = Date.parse(r.submitted_at ?? "");
          if (at > latest) latest = at;
          if (!at || at < sinceMs || !r.comments_count) continue;
          const cs = (await forgeApi(base, token, `/repos/${repo}/pulls/${num}/reviews/${r.id}/comments?limit=50`).catch(() => [])) ?? [];
          inline24h += cs.length;
          inlineP0P2 += cs.filter((c) => P02.test(c.body ?? "")).length;
        }
        for (const c of comments) {
          const at = Date.parse(c.created_at ?? "");
          if (at > latest) latest = at;
        }
        // 同一 context 会有多条状态（先 pending 后 failure），按最坏取一条，避免重复计数。
        const rank = { success: 1, pending: 2, failure: 3, error: 3 };
        const byCtx = new Map();
        for (const st of statuses) {
          if (!st.context) continue;
          const cur = byCtx.get(st.context);
          if (!cur || (rank[st.status] ?? 0) > (rank[cur] ?? 0)) byCtx.set(st.context, st.status);
        }
        const openHours = pr.created_at ? Math.round((Date.now() - Date.parse(pr.created_at)) / 36000) / 100 : null;
        const reviewRounds = roundOf([...reviews.map((r) => r.body), ...comments.map((c) => c.body)]);
        return {
          repo,
          num: Number(num),
          host: base,
          latestAt: latest ? new Date(latest).toISOString() : null,
          failChecks: [...byCtx].filter(([, st]) => st === "failure" || st === "error").map(([c]) => c),
          pendingChecks: [...byCtx].filter(([, st]) => st === "pending").length,
          openHours,
          reviewRounds,
          inline24h,
          inlineP0P2,
          needsConvergenceAudit: NEED_AUDIT(openHours, reviewRounds, inlineP0P2),
        };
      } catch (e) {
        if (DEBUG) console.error("forgejo live failed", base, repo, num, String(e.message ?? e).slice(0, 200));
      }
    }
  }
  return null;
}

async function prLiveOf(pr, hint) {
  if (liveCache.has(pr)) return liveCache.get(pr);
  const out = await prLiveUncached(pr, hint);
  liveCache.set(pr, out);
  return out;
}

async function prLiveUncached(pr, hint) {
  const m = String(pr).match(/^(.+?)#(\d+):open/);
  if (!m) return null;
  const repo = m[1];
  const num = m[2];
  const { execFileSync } = await import("node:child_process");
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  let base;
  try {
    base = JSON.parse(gh(["pr", "view", num, "--repo", repo, "--json", "createdAt,reviews,comments,statusCheckRollup", "--jq", ROUNDS_JQ]) || "{}");
  } catch (e) {
    if (DEBUG) console.error("gh pr view failed", pr, String(e.message ?? e).slice(0, 200));
    const fj = await forgejoLiveOf(repo, num, hint);
    if (fj) return fj;
    return { repo, num: Number(num), unavailable: true };
  }
  const openHours = base.createdAt ? Math.round((Date.now() - Date.parse(base.createdAt)) / 36000) / 100 : null;
  // 行内意见单独走 API：review 的 body 不包含行内意见。只翻最后几页（关心的是 24h 内），
  // 一页全部早于窗口就停；统计在 gh 端用 jq 做完，避免大输出撑爆缓冲区（曾因 ENOBUFS 静默丢统计）。
  let inline24h = null;
  let inlineP0P2 = null;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const total = Number(gh(["api", `repos/${repo}/pulls/${num}`, "--jq", ".review_comments"]).trim()) || 0;
    const lastPage = Math.max(1, Math.ceil(total / 100));
    const pageJq = `{n:length, oldest:(.[0].created_at), n24:([.[]|select(.created_at > "${since}")]|length), p0p2:([.[]|select(.created_at > "${since}")|select((.body // "")|test("\\\\bP[0-2]\\\\b"))]|length)}`;
    let n24 = 0;
    let p0p2 = 0;
    for (let page = lastPage; page > Math.max(0, lastPage - 5); page--) {
      const r = JSON.parse(gh(["api", `repos/${repo}/pulls/${num}/comments?per_page=100&page=${page}`, "--jq", pageJq]) || "{}");
      n24 += r.n24 ?? 0;
      p0p2 += r.p0p2 ?? 0;
      if (!r.n || (r.oldest && r.oldest <= since)) break;
    }
    if (DEBUG) console.error("health", pr, { total, n24, p0p2 });
    inline24h = n24;
    inlineP0P2 = p0p2;
  } catch (e) {
    if (DEBUG) console.error("inline stats failed", pr, String(e.message ?? e).slice(0, 300));
  }
  const reviewRounds = base.rounds ?? null;
  return {
    repo,
    num: Number(num),
    host: "github.com",
    latestAt: base.review ?? base.comment ?? null,
    failChecks: base.failChecks ?? [],
    pendingChecks: base.pendingChecks ?? 0,
    openHours,
    reviewRounds,
    inline24h,
    inlineP0P2,
    needsConvergenceAudit: NEED_AUDIT(openHours, reviewRounds, inlineP0P2),
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

// 久审未收敛：开放时长或轮次越线、且 24 小时内还有 P0–P2 行内意见。
// 这类线程看起来最健康（一直在跑、一直有新结论），却正是最该发收敛审计的。
function convergenceOf(health) {
  const hit = (health ?? []).filter((h) => h?.needsConvergenceAudit);
  if (!hit.length) return { needsConvergenceAudit: false };
  return {
    needsConvergenceAudit: true,
    convergenceAuditPrs: hit.map((h) => `#${h.num}(${h.openHours}h/${h.reviewRounds ?? "?"}轮/${h.inlineP0P2}条P0-P2@24h/${h.repo})`),
  };
}

async function snapshotEnv(env) {
  const now = Date.now();
  const all = await listAll(env.isLocal ? null : env.environmentId);
  const top = all.filter((t) => !isSubagent(t));
  const candidates = top.filter((t) => !isReviewBot(t) && t.threadId !== SELF);
  const enriched = await Promise.all(
    candidates.map(async (t) => {      const base = {
        id: t.threadId,
        link: t.link,
        title: clip(t.title, 80),
        createdBy: t.createdBy,
        status: t.status,
        updatedAt: t.updatedAt,
        projectId: t.projectId,
        model: `${t.providerInstanceId}/${t.model}`,
        hasWorktree: Boolean(t.worktreePath),
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
        const prs = livePrs
          ? await Promise.all(
              livePrs.map(async (p) => {
                let tag = `${p.repository}#${p.number}:${p.state}${p.watching === false ? "(unwatched)" : ""}`;
                if (p.state !== "open") return tag;
                const live = await prLiveOf(tag, p.url);
                if (!live) return tag;
                if (live.unavailable) return `${tag}(health-unavailable)`;
                health.push(live);
                if (p.watching !== false && live.latestAt && Date.parse(live.latestAt) > lastMsgMs) tag += "(stale)";
                return tag;
              }),
            )
          : base.prs;
        return { ...base, prs, ...tail, ...needsWatchOf(prs), ...convergenceOf(health) };
      } catch (e) {
        return { ...base, error: String(e.message ?? e) };
      }
    }),
  );
  // 占用名额的线程：有活跃 run 的（含 Fast Ship 审查线程），或 PR 仍 open、最近 2 小时内跑过的（两轮审查之间
  // 线程会暂时 completed，但工作树和编译资源还占着）。PR 已合并/关闭、没有 PR 又没在跑的线程不占名额。
  // 不用 updatedAt：同步会批量刷新它。
  const byId = new Map(enriched.map((x) => [x.id, x]));
  const occupying = top.filter((t) => {
    if (LIVE.has(t.status)) return true;
    const prs = t.pullRequests ?? [];
    if (!prs.some((p) => p.state === "open")) return false;
    const ended = Date.parse(byId.get(t.threadId)?.lastRunEndedAt ?? "");
    return Number.isFinite(ended) && now - ended < ACTIVE_MS;
  });
  const active = occupying.length;
  const occupyingTitles = occupying.map((t) => clip(t.title, 40));
  const real = enriched.filter((x) => !isDelegatedTask(x.task, x.hasWorktree));
  // 兜底对账：被任何过滤规则排除、但停在失败态的真实顶层线程。过滤规则一改就可能误杀，
  // 把误杀的线程留在这份名单里，巡检每轮必须逐个过——静默消失比多算几条候选危险得多。
  const realIds = new Set(real.map((x) => x.id));
  const failedTopLevel = top
    .filter((t) => ["failed", "interrupted", "cancelled"].includes(t.status) && !realIds.has(t.threadId))
    .map((t) => ({ id: t.threadId, link: t.link, title: clip(t.title, 60), status: t.status, updatedAt: t.updatedAt }));
  return {
    environmentId: env.environmentId,
    label: env.label,
    activeTopLevel: active,
    occupying: occupyingTitles,
    candidates: real,
    delegatedExcluded: enriched.length - real.length,
    failedTopLevel,
  };
}

async function main() {
  if (!URL_ || !TOKEN) {
    console.error("缺少 T3_MCP_URL / T3_MCP_BEARER_TOKEN：改用 MCP 工具按技能步骤手工取证。");
    process.exit(2);
  }
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t3-patrol", version: "1" } });
  const links = await call("t3_environment_links", {});
  const envs = [{ environmentId: links.environmentId, label: "本机", isLocal: true }];
  const unreachable = [];
  for (const l of links.links ?? []) {
    if (l.status === "reachable") envs.push({ environmentId: l.environmentId, label: l.label });
    else unreachable.push({ environmentId: l.environmentId, label: l.label, status: l.status, error: l.lastError });
  }
  const results = await Promise.all(
    envs.map((e) => snapshotEnv(e).catch((err) => ({ environmentId: e.environmentId, label: e.label, error: String(err.message ?? err) }))),
  );
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), unreachable, environments: results }, null, 1));
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
