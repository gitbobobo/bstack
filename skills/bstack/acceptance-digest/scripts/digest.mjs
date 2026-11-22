#!/usr/bin/env node
// 验收清单：收集各仓库近 N 小时合并的 PR，按模型的验收判定逐项目渲染网页并上传 HTML Preview。
//
// 用法：
//   node digest.mjs collect [--hours 24] [--repo <canonicalKey>]...   → <dir>/prs.json，stdout 输出各仓库计数
//   node digest.mjs publish <verdicts.json> [--dry-run]                → <dir>/<项目>.html，上传后 stdout 输出报告
// 仓库缺省取 t3-dispatch 的 repos 与 t3-patrol 的 capacity.projects 之并集（同属 bstack，安装时同级排布）。
// 产物目录缺省 /tmp/acceptance-digest，ACCEPTANCE_DIGEST_DIR 可改。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig as loadDispatch } from "../../t3-dispatch/scripts/dispatch-config.mjs";
import { loadConfig as loadPatrol } from "../../t3-patrol/scripts/patrol-config.mjs";
import { credentialFor, forgeApi, forgeConf } from "../../t3-patrol/scripts/pr-live.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEMPLATE_PATH = join(SKILL_DIR, "assets", "page.html");
const outDir = (env = process.env) => env.ACCEPTANCE_DIGEST_DIR || "/tmp/acceptance-digest";
// 只认验收层面的豁免与未测；lint 指令的「豁免」不算。
const WAIVER = /.{0,40}(?:按巡检授权豁免|豁免(?:人工|实体设备|真机)|(?:实体设备|真机|物理机)未测|未(?:在|经)(?:实体设备|真机|物理机)|待人工验收|manual(?:ly)? (?:test|verif)\w* (?:pending|skipped)).{0,40}/gi;

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\r/g, "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function parseRepoKey(key) {
  const [host, owner, name] = String(key).toLowerCase().split("/");
  if (!host || !owner || !name) throw new Error(`仓库应为 canonicalKey（host/owner/name）：${key}`);
  return { key: `${host}/${owner}/${name}`, host, repo: `${owner}/${name}`, name, web: `https://${host}/${owner}/${name}` };
}

export const repoList = (...lists) => [...new Set(lists.flat().map((r) => parseRepoKey(r).key))];

export function factOf(raw) {
  const files = raw.files ?? [];
  const text = [raw.body, ...(raw.comments ?? []).map((c) => c.body)].join("\n");
  return {
    num: raw.num,
    title: raw.title,
    url: raw.url,
    author: raw.author ?? null,
    mergedAt: raw.mergedAt,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    changedFiles: raw.changedFiles ?? files.length,
    labels: raw.labels ?? [],
    files: files.slice(0, 60).map((f) => `${f.path} +${f.additions ?? "?"}/-${f.deletions ?? "?"}`),
    waiverHints: [...new Set([...text.matchAll(WAIVER)].map((m) => m[0].replace(/\s+/g, " ").trim()))].slice(0, 3),
    body: clip(raw.body, 1500),
    comments: (raw.comments ?? []).slice(-5).map((c) => ({ by: c.by ?? null, body: clip(c.body, 400) })),
  };
}

function githubMerged({ repo }, sinceIso) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "merged", "--limit", "100", "--search", `merged:>=${sinceIso.slice(0, 19)}Z`, "--json", "number,title,url,body,mergedAt,author,additions,deletions,changedFiles,files,labels,comments"],
    { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
  );
  return JSON.parse(out || "[]")
    .filter((p) => Date.parse(p.mergedAt) >= Date.parse(sinceIso))
    .map((p) => ({
      num: p.number,
      title: p.title,
      url: p.url,
      body: p.body,
      mergedAt: p.mergedAt,
      author: p.author?.login,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      files: (p.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      labels: (p.labels ?? []).map((l) => l.name),
      comments: (p.comments ?? []).map((c) => ({ by: c.author?.login, body: c.body })),
    }));
}

async function forgejoMerged({ host, repo }, sinceIso) {
  const base = `https://${host}`;
  const tokens = [...new Set([...forgeConf().tokens, credentialFor(base)].filter(Boolean))];
  if (!tokens.length) throw new Error(`${host} 没有可用凭据（git credential / FORGEJO_TOKEN）`);
  let token = null;
  let lastErr = null;
  for (const t of tokens) {
    try {
      await forgeApi(base, t, `/repos/${repo}`);
      token = t;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!token) throw lastErr;
  const since = Date.parse(sinceIso);
  const hits = [];
  // 按最近更新倒序翻页：合并时间不晚于更新时间，整页都早于窗口即可停。
  for (let page = 1; page <= 10; page++) {
    const batch = (await forgeApi(base, token, `/repos/${repo}/pulls?state=closed&sort=recentupdate&limit=50&page=${page}`)) ?? [];
    hits.push(...batch.filter((p) => p.merged && Date.parse(p.merged_at) >= since));
    if (batch.length < 50 || batch.every((p) => Date.parse(p.updated_at) < since)) break;
  }
  const out = [];
  for (const p of hits) {
    const files = (await forgeApi(base, token, `/repos/${repo}/pulls/${p.number}/files?limit=100`).catch(() => [])) ?? [];
    const comments = (await forgeApi(base, token, `/repos/${repo}/issues/${p.number}/comments?limit=50`).catch(() => [])) ?? [];
    out.push({
      num: p.number,
      title: p.title,
      url: p.html_url,
      body: p.body,
      mergedAt: new Date(p.merged_at).toISOString(),
      author: p.user?.login,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changed_files,
      files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
      labels: (p.labels ?? []).map((l) => l.name),
      comments: comments.map((c) => ({ by: c.user?.login, body: c.body })),
    });
  }
  return out;
}

async function collect({ hours, repos }) {
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000).toISOString();
  const result = { since, until: until.toISOString(), repos: [] };
  for (const key of repos) {
    const r = parseRepoKey(key);
    try {
      const raw = r.host === "github.com" ? githubMerged(r, since) : await forgejoMerged(r, since);
      raw.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
      result.repos.push({ repo: r.key, web: r.web, prs: raw.map(factOf) });
    } catch (e) {
      result.repos.push({ repo: r.key, web: r.web, prs: [], error: clip(e.stderr || e.message || e, 300) });
    }
  }
  return result;
}

// 每个合并的 PR 必须且只能落进 accept 或 skip 之一；accept 项须有可执行的验收步骤。
export function validateVerdicts(collected, verdicts) {
  const errors = [];
  const pages = [];
  const given = verdicts?.projects ?? {};
  for (const k of Object.keys(given)) if (!collected.repos.some((r) => r.repo === k)) errors.push(`${k}：不在 prs.json 里`);
  for (const r of collected.repos) {
    if (!r.prs.length) continue;
    const v = given[r.repo];
    if (!v) {
      errors.push(`${r.repo}：缺判定（${r.prs.length} 个 PR）`);
      continue;
    }
    const byNum = new Map(r.prs.map((p) => [p.num, p]));
    const seen = new Map();
    const accept = [];
    const skip = [];
    for (const [kind, list] of [["accept", v.accept ?? []], ["skip", v.skip ?? []]]) {
      for (const item of list) {
        const pr = byNum.get(item.num);
        if (!pr) {
          errors.push(`${r.repo}#${item.num}：不是窗口内合并的 PR`);
          continue;
        }
        if (seen.has(item.num)) {
          errors.push(`${r.repo}#${item.num}：同时出现在 ${seen.get(item.num)} 与 ${kind}`);
          continue;
        }
        seen.set(item.num, kind);
        if (kind === "skip") {
          if (!item.reason) errors.push(`${r.repo}#${item.num}：skip 缺 reason`);
          skip.push({ num: pr.num, title: pr.title, url: pr.url, reason: item.reason ?? "" });
          continue;
        }
        const missing = ["summary", "why"].filter((f) => !item[f]);
        if (!Array.isArray(item.checks) || !item.checks.length) missing.push("checks");
        if (missing.length) errors.push(`${r.repo}#${item.num}：accept 缺 ${missing.join("、")}`);
        accept.push({
          num: pr.num,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          mergedAt: pr.mergedAt,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          risk: item.risk === "high" ? "high" : "normal",
          summary: item.summary ?? "",
          why: item.why ?? "",
          checks: item.checks ?? [],
          evidence: item.evidence ?? "",
        });
      }
    }
    for (const p of r.prs) if (!seen.has(p.num)) errors.push(`${r.repo}#${p.num}：未判定`);
    accept.sort((a, b) => (a.risk === b.risk ? 0 : a.risk === "high" ? -1 : 1));
    if (accept.length) pages.push({ repo: r.repo, name: parseRepoKey(r.repo).name, web: r.web, since: collected.since, until: collected.until, accept, skip });
  }
  return { errors, pages };
}

export const renderPage = (template, data) => template.replace("/*DATA*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));

function previewConfig() {
  const file = join(homedir(), ".config", "html-preview", "config.yaml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const get = (k) => text.match(new RegExp(`^${k}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m"))?.[1]?.trim();
  const base = get("base_url")?.replace(/\/+$/, "");
  const key = get("api_key");
  return base && key ? { base, key } : null;
}

async function upload(conf, html, { title, notes }) {
  const form = new FormData();
  form.append("file", new Blob([html], { type: "text/html" }), "index.html");
  form.append("title", title);
  form.append("notes", notes);
  form.append("expires_in", "7d");
  const res = await fetch(`${conf.base}/api/items`, { method: "POST", headers: { authorization: `Bearer ${conf.key}` }, body: form, signal: AbortSignal.timeout(60000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) throw new Error(`上传失败 HTTP ${res.status} code ${body.code ?? "?"}：${body.message ?? ""}`);
  return `${conf.base}${body.data.public_path}`;
}

const day = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

async function publish(verdictsPath, { dryRun }) {
  const dir = outDir();
  const collected = JSON.parse(readFileSync(join(dir, "prs.json"), "utf8"));
  const { errors, pages } = validateVerdicts(collected, JSON.parse(readFileSync(verdictsPath, "utf8")));
  if (errors.length) {
    console.error(`判定不完整，未生成网页：\n- ${errors.join("\n- ")}`);
    return 1;
  }
  const conf = dryRun ? null : previewConfig();
  if (!dryRun && !conf) {
    console.error("缺 ~/.config/html-preview/config.yaml：按 html-preview 技能的首次使用流程配置后重跑");
    return 2;
  }
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const lines = [`验收窗口 ${collected.since} → ${collected.until}`];
  for (const page of pages) {
    const html = renderPage(template, { ...page, generatedAt: new Date().toISOString() });
    const file = join(dir, `${page.name}.html`);
    writeFileSync(file, html);
    const high = page.accept.filter((a) => a.risk === "high").length;
    const url = dryRun ? file : await upload(conf, html, { title: `验收 · ${page.name} · ${day(collected.until)}`, notes: `${page.repo}：${page.accept.length} 个 PR 待验收${high ? `（${high} 个高风险）` : ""}` });
    lines.push(`- ${page.name}：${page.accept.length} 个待验收${high ? `，${high} 个高风险` : ""}，免验收 ${page.skip.length} 个 → ${url}`);
  }
  for (const r of collected.repos) {
    if (r.error) lines.push(`- ${parseRepoKey(r.repo).name}：取数失败（${r.error}）`);
    else if (!pages.some((p) => p.repo === r.repo)) lines.push(`- ${parseRepoKey(r.repo).name}：${r.prs.length ? `${r.prs.length} 个合并均免验收` : "窗口内无合并"}`);
  }
  console.log(lines.join("\n"));
  return 0;
}

function parseArgs(argv) {
  const opts = { hours: 24, repos: [], dryRun: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hours") opts.hours = Number(argv[++i]);
    else if (a === "--repo") opts.repos.push(argv[++i]);
    else if (a === "--dry-run") opts.dryRun = true;
    else opts.rest.push(a);
  }
  if (!(opts.hours > 0)) throw new Error("--hours 应为正数");
  return opts;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (cmd === "collect") {
    const repos = opts.repos.length
      ? repoList(opts.repos)
      : repoList(
          loadDispatch().config.repos.map((r) => r.repo),
          loadPatrol().config.capacity.projects.map((p) => p.repo),
        );
    const result = await collect({ hours: opts.hours, repos });
    mkdirSync(outDir(), { recursive: true });
    writeFileSync(join(outDir(), "prs.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ file: join(outDir(), "prs.json"), since: result.since, repos: result.repos.map((r) => ({ repo: r.repo, merged: r.prs.length, ...(r.error ? { error: r.error } : {}) })) }, null, 2));
    return 0;
  }
  if (cmd === "publish" && opts.rest[0]) return publish(opts.rest[0], opts);
  console.error("用法：digest.mjs collect [--hours N] [--repo key]... | publish <verdicts.json> [--dry-run]");
  return 64;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e.stack ?? e);
      process.exitCode = 1;
    },
  );
}
