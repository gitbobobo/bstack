// PR 实况：github.com 走 gh，其他宿主（Forgejo/Gitea）走 REST。快照与补读脚本共用。
//
// 只走 gh 会让搬去 Forgejo 的仓库静默失明：(stale)、久审不收敛、PR 健康度全都不触发。
// 输出的是判定事实，不是线索：最新 HEAD 及其时间、HEAD 上的最新结论、未解决行内意见数、检查状态。
// 巡检直接据此判「审查在途 / 有未处理结论 / 已收敛」，只在字段缺失时才自己去宿主补查。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEBUG = !!process.env.T3_PATROL_DEBUG;
let AUDIT = { openHours: 12, reviewRounds: 5 };
export const configure = ({ convergenceAudit } = {}) => {
  if (convergenceAudit) AUDIT = convergenceAudit;
};

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const hoursSince = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 36000) / 100 : null);

export const roundOf = (texts) => {
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
// 轮次线对齐 pr-review-loop 的预算上限（默认 3、最多 5）：越过它还在冒意见，就该发预算收口。
const needAudit = (openHours, reviewRounds, inlineP0P2) =>
  Boolean(((openHours ?? 0) > AUDIT.openHours || (reviewRounds ?? 0) > AUDIT.reviewRounds) && (inlineP0P2 ?? 0) > 0);

// 检查状态归一：success / failure / pending。同一 context 多条时取最新一条（先 pending 后 success 很常见）。
const STATE_OF = (raw) => {
  const v = String(raw ?? "").toLowerCase();
  if (["success", "neutral", "skipped"].includes(v)) return "success";
  if (["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure"].includes(v)) return "failure";
  return "pending";
};
export function latestChecks(list) {
  const byName = new Map();
  for (const c of list) {
    if (!c.name) continue;
    const cur = byName.get(c.name);
    if (!cur || Date.parse(c.at ?? "") > Date.parse(cur.at ?? "")) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => ({ name: c.name, state: STATE_OF(c.state), at: c.at ?? null, ...(c.desc ? { desc: clip(c.desc, 80) } : {}) }));
}
// 最新事件时间：review、评论与检查出结论（非 pending）的时间取最大。用于对账「有新结论而线程没反应」。
const latestOf = (...isos) => {
  const t = Math.max(0, ...isos.map((x) => Date.parse(x ?? "") || 0));
  return t ? new Date(t).toISOString() : null;
};
const concludedAts = (checks) => checks.filter((c) => c.state !== "pending").map((c) => c.at);
const checkSummary = (checks) => ({
  checks,
  failChecks: checks.filter((c) => c.state === "failure").map((c) => c.name),
  pendingChecks: checks.filter((c) => c.state === "pending").length,
});

// HEAD 上的最新结论：只认 commit 等于当前 HEAD、已提交（非 PENDING / 请求审查）的 review。
// 旧 HEAD 的通过不代表当前 HEAD 通过——推送后结论作废，这正是「审查在途」与「已收敛」的分界。
export function headReviewOf(reviews, headSha) {
  const onHead = reviews.filter((r) => r.sha && headSha && r.sha.startsWith(headSha.slice(0, 7)) && r.at && !/PENDING|REQUEST_REVIEW/i.test(r.state ?? ""));
  onHead.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = onHead.at(-1);
  return { reviewsOnHead: onHead.length, headReview: last ? { by: last.by ?? null, state: last.state, at: last.at } : null };
}

// ---- Forgejo / Gitea ----

// 端点地址与凭据：环境变量 → ~/.agents/env/forgejo.sh → fj 实例列表 → git credential helper。
let confCache = null;
function forgeConf() {
  if (confCache) return confCache;
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
  // fj 的自建实例列表是宿主的最省事来源：装了 fj 并登录过的机器不用再配 FORGEJO_BASE。
  try {
    for (const line of execFileSync("fj", ["auth", "list"], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).split("\n")) {
      const host = line.trim().replace(/[\u2066-\u2069]/g, "").replace(/STYLE\(\)/g, "");
      if (/^[\w.-]+\.[a-z]{2,}(:\d+)?$/i.test(host)) bases.push(`https://${host}`);
    }
  } catch {}
  confCache = {
    bases: [...new Set(bases.map((b) => b.replace(/\/+$/, "")).filter(Boolean))],
    tokens: [...new Set(tokens.filter(Boolean))],
  };
  return confCache;
}

function baseFromHint(hint) {
  if (!hint) return null;
  // PR 自己的 URL 最可靠：T3 记录的 pullRequests[].url 就带宿主，工作树收尾后已回收也不影响。
  try {
    const host = new URL(String(hint)).origin;
    if (/^https?:/.test(host)) return host;
  } catch {}
  try {
    const url = execFileSync("git", ["-C", hint, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    const m = url.match(/^(https?):\/\/([^/]+)/);
    return m ? `${m[1]}://${m[2]}` : null;
  } catch {
    return null;
  }
}

const credCache = new Map();
function credentialFor(base) {
  if (credCache.has(base)) return credCache.get(base);
  let token = null;
  try {
    const u = new URL(base);
    const out = execFileSync("git", ["credential", "fill"], {
      input: `protocol=${u.protocol.replace(":", "")}\nhost=${u.host}\n\n`,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const hit = out.split("\n").find((l) => l.startsWith("password="));
    token = hit ? hit.slice("password=".length) : null;
  } catch {}
  credCache.set(base, token);
  return token;
}

async function forgeApi(base, token, path) {
  const res = await fetch(`${base}/api/v1${path}`, {
    headers: { authorization: `token ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
// Gitea 列表按时间正序分页：只取第一页会在长 PR 上丢掉最新的 review 与评论。
async function forgeAll(base, token, path, limit = 50, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = (await forgeApi(base, token, `${path}${path.includes("?") ? "&" : "?"}limit=${limit}&page=${page}`)) ?? [];
    out.push(...batch);
    if (batch.length < limit) break;
  }
  return out;
}

// 找到能读这个 PR 的 (base, token)，按宿主缓存。
const authCache = new Map();
async function forgeAuth(repo, num, hint) {
  const conf = forgeConf();
  const bases = [];
  const fromHint = baseFromHint(hint);
  if (fromHint) bases.push(fromHint);
  for (const b of conf.bases) if (!bases.includes(b)) bases.push(b);
  for (const base of bases) {
    const cached = authCache.get(base);
    const tokens = cached ? [cached] : [...new Set([...conf.tokens, credentialFor(base)].filter(Boolean))];
    for (const token of tokens) {
      try {
        const pr = await forgeApi(base, token, `/repos/${repo}/pulls/${num}`);
        authCache.set(base, token);
        return { base, token, pr };
      } catch (e) {
        if (DEBUG) console.error("forgejo auth failed", base, repo, num, String(e.message ?? e).slice(0, 200));
      }
    }
  }
  return null;
}

const forgeReview = (r) => ({ id: r.id, sha: r.commit_id ?? null, state: r.state, at: r.submitted_at ?? null, by: r.user?.login ?? null, body: r.body, comments: r.comments_count ?? 0, stale: r.stale, dismissed: r.dismissed });

async function forgejoLiveOf(repo, num, hint) {
  const auth = await forgeAuth(repo, num, hint);
  if (!auth) return null;
  const { base, token, pr } = auth;
  const headSha = pr.head?.sha ?? null;
  const [reviewsRaw, comments, commit] = await Promise.all([
    forgeAll(base, token, `/repos/${repo}/pulls/${num}/reviews`).catch(() => []),
    forgeAll(base, token, `/repos/${repo}/issues/${num}/comments`, 50).catch(() => []),
    headSha ? forgeApi(base, token, `/repos/${repo}/git/commits/${headSha}?stat=false&verification=false&files=false`).catch(() => null) : null,
  ]);
  const reviews = reviewsRaw.map(forgeReview);
  const sinceMs = Date.now() - 24 * 3600 * 1000;
  let inline24h = 0;
  let inlineP0P2 = 0;
  let latest = 0;
  for (const r of reviews.filter((x) => x.comments && Date.parse(x.at ?? "") >= sinceMs).slice(-12)) {
    const cs = (await forgeApi(base, token, `/repos/${repo}/pulls/${num}/reviews/${r.id}/comments`).catch(() => [])) ?? [];
    inline24h += cs.length;
    inlineP0P2 += cs.filter((c) => P02.test(c.body ?? "")).length;
  }
  for (const r of reviews) latest = Math.max(latest, Date.parse(r.at ?? "") || 0);
  const lastComment = comments.at(-1);
  for (const c of comments) latest = Math.max(latest, Date.parse(c.created_at ?? "") || 0);
  // 审查服务常把结论写成 HEAD 上的提交状态（如「代码审查 success / pending」），而不是 review：两者都要看。
  const statuses = headSha ? await forgeAll(base, token, `/repos/${repo}/commits/${headSha}/statuses`).catch(() => []) : [];
  const checks = latestChecks(statuses.map((st) => ({ name: st.context, state: st.status, at: st.updated_at ?? st.created_at, desc: st.description })));
  const openHours = hoursSince(pr.created_at);
  const reviewRounds = roundOf([...reviews.map((r) => r.body), ...comments.map((c) => c.body)]);
  return {
    repo,
    num: Number(num),
    host: base,
    head: headSha?.slice(0, 10) ?? null,
    headAt: commit?.commit?.committer?.date ?? commit?.created ?? null,
    ...headReviewOf(reviews, headSha),
    lastCommentAt: lastComment?.created_at ?? null,
    lastCommentBy: lastComment?.user?.login ?? null,
    latestAt: latestOf(latest ? new Date(latest).toISOString() : null, ...concludedAts(checks)),
    ...checkSummary(checks),
    mergeable: typeof pr.mergeable === "boolean" ? (pr.mergeable ? "Can be merged" : "Conflicting") : null,
    openHours,
    reviewRounds,
    inline24h,
    inlineP0P2,
    needsConvergenceAudit: needAudit(openHours, reviewRounds, inlineP0P2),
  };
}

// ---- GitHub ----

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const GH_JQ =
  "{createdAt, mergeStateStatus, headRefOid, headAt:(.commits|last|.committedDate)," +
  " reviews:[.reviews[]|{sha:.commit.oid, state, at:.submittedAt, by:.author.login, body}]," +
  " comment:(.comments|last|{at:.createdAt, by:.author.login})," +
  ' rounds:([((.reviews[]?.body // ""), (.comments[]?.body // ""))]),' +
  " checks:[.statusCheckRollup[]|{name:(.name // .context), state:(.conclusion // .state // .status // \"\"), at:(.completedAt // .startedAt // .createdAt), desc:(.description // \"\")}]}";
const THREADS_Q =
  "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(last:100){nodes{isResolved comments(first:1){nodes{body path author{login}}}}}}}}";

function ghThreads(repo, num) {
  const [o, r] = repo.split("/");
  const out = JSON.parse(gh(["api", "graphql", "-f", `query=${THREADS_Q}`, "-F", `o=${o}`, "-F", `r=${r}`, "-F", `n=${num}`]));
  return out.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
}

function githubLiveOf(repo, num) {
  const base = JSON.parse(
    gh(["pr", "view", num, "--repo", repo, "--json", "createdAt,reviews,comments,statusCheckRollup,mergeStateStatus,headRefOid,commits", "--jq", GH_JQ]) || "{}",
  );
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
    inline24h = n24;
    inlineP0P2 = p0p2;
  } catch (e) {
    if (DEBUG) console.error("inline stats failed", repo, num, String(e.message ?? e).slice(0, 300));
  }
  const reviews = base.reviews ?? [];
  const openHours = hoursSince(base.createdAt);
  const reviewRounds = roundOf(base.rounds ?? []);
  const checks = latestChecks(base.checks ?? []);
  const latest = latestOf(...reviews.map((r) => r.at), base.comment?.at, ...concludedAts(checks));
  return {
    repo,
    num: Number(num),
    host: "github.com",
    head: base.headRefOid?.slice(0, 10) ?? null,
    headAt: base.headAt ?? null,
    ...headReviewOf(reviews, base.headRefOid),
    lastCommentAt: base.comment?.at ?? null,
    lastCommentBy: base.comment?.by ?? null,
    latestAt: latest,
    ...checkSummary(checks),
    mergeable: base.mergeStateStatus ?? null,
    openHours,
    reviewRounds,
    inline24h,
    inlineP0P2,
    needsConvergenceAudit: needAudit(openHours, reviewRounds, inlineP0P2),
  };
}

// ---- 入口 ----

const parseTag = (pr) => String(pr).match(/^(.+?)#(\d+)/);
const liveCache = new Map();

// pr 形如 `owner/repo#12:open`（快照标签）或 `owner/repo#12`；hint 是 PR URL 或工作树路径。
export async function prLiveOf(pr, hint) {
  const m = parseTag(pr);
  if (!m) return null;
  const key = `${m[1]}#${m[2]}`;
  if (liveCache.has(key)) return liveCache.get(key);
  let out = null;
  // PR URL 已表明是 GitHub 以外的宿主时不先试 gh：每个 Forgejo PR 都白等一次 gh 失败。
  const host = (() => {
    try {
      return new URL(String(hint)).host;
    } catch {
      return null;
    }
  })();
  if (!host || host === "github.com") {
    try {
      out = githubLiveOf(m[1], m[2]);
    } catch (e) {
      if (DEBUG) console.error("gh pr view failed", key, String(e.message ?? e).slice(0, 200));
    }
  }
  out ??= (await forgejoLiveOf(m[1], m[2], hint).catch(() => null)) ?? { repo: m[1], num: Number(m[2]), unavailable: true };
  liveCache.set(key, out);
  return out;
}

// 补读用：最近一次 review 的正文与行内意见、HEAD 检查、PR 描述与最近评论，供 M9 / 收尾判定引用出处。
// 「未解决」只在 GitHub 上可信（reviewThreads.isResolved）；Forgejo 的工作流常只回复不标记 resolved，不据此计数。
export async function prDetailOf(pr, hint, { chars = 600, comments = 5 } = {}) {
  const m = parseTag(pr);
  if (!m) throw new Error(`PR 标识应为 owner/repo#N：${pr}`);
  const [repo, num] = [m[1], m[2]];
  const live = await prLiveOf(`${repo}#${num}`, hint);
  if (!live || live.unavailable) return { ...(live ?? {}), detail: null };
  const short = (r) => ({ sha: r.sha?.slice(0, 10) ?? null, onHead: Boolean(r.sha && live.head && r.sha.startsWith(live.head)), state: r.state, at: r.at, by: r.by, body: clip(r.body, chars) });
  if (live.host === "github.com") {
    const d = JSON.parse(gh(["pr", "view", num, "--repo", repo, "--json", "reviews,comments,body", "--jq", "{body, reviews:[.reviews[]|{sha:.commit.oid,state,at:.submittedAt,by:.author.login,body}], comments:[.comments[]|{at:.createdAt,by:.author.login,body}]}"]));
    let threads = [];
    try {
      threads = ghThreads(repo, num);
    } catch {}
    const last = d.reviews.at(-1);
    return {
      ...live,
      detail: {
        body: clip(d.body, chars * 2),
        lastReview: last ? short(last) : null,
        unresolvedThreads: threads.filter((t) => !t.isResolved).map((t) => ({ path: t.comments.nodes[0]?.path, by: t.comments.nodes[0]?.author?.login, body: clip(t.comments.nodes[0]?.body, chars) })),
        recentComments: d.comments.slice(-comments).map((c) => ({ ...c, body: clip(c.body, chars) })),
      },
    };
  }
  const auth = await forgeAuth(repo, num, hint ?? live.host);
  if (!auth) return { ...live, detail: null };
  const { base, token, pr: raw } = auth;
  const reviews = (await forgeAll(base, token, `/repos/${repo}/pulls/${num}/reviews`)).map(forgeReview).filter((r) => r.at);
  const last = reviews.at(-1);
  const inline = last?.comments
    ? ((await forgeApi(base, token, `/repos/${repo}/pulls/${num}/reviews/${last.id}/comments`).catch(() => [])) ?? []).map((c) => ({ path: c.path, line: c.position ?? c.original_position, body: clip(c.body, chars) }))
    : [];
  const cmts = await forgeAll(base, token, `/repos/${repo}/issues/${num}/comments`, 50);
  return {
    ...live,
    detail: {
      body: clip(raw.body, chars * 2),
      lastReview: last ? { ...short(last), inline } : null,
      recentComments: cmts.slice(-comments).map((c) => ({ at: c.created_at, by: c.user?.login, body: clip(c.body, chars) })),
    },
  };
}
