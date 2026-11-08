#!/usr/bin/env node
// 派出：按计划文件逐条认领、渲染提示词、建工作树线程、记账、回读，失败归还。取代每轮现写的派活脚本。
//
// 用法：node dispatch-launch.mjs --plan <计划 JSON> [--dry-run]
// 计划 JSON（UTF-8 文件，推荐理由写在里面，不进命令行）：
//   { "launches": [ { "repo": "<repos[].repo>", "ids": ["<问题 ID>", …], "environmentId": "…", "projectId": "…",
//                     "title": "INT-1234 主题", "reason": "推荐理由" } ] }
//   ids 第一个是主问题（提示词按它渲染），其余是合并进同一线程的重复问题，一并认领、记账。
// 逐条执行，一条做完再做下一条：
//   0. 查重：按主问题编号在各可达环境该仓库的项目里 t3_thread_search，标题或任务书命中未结线程就跳过整条
//      （挑选可能越出 dispatch-plan 的备选表，表外问题没查过重）；
//   1. 认领 ids（主问题认领失败就跳过整条；附带问题失败只记下）；
//   2. 推荐理由写临时文件，按主问题渲染提示词；
//   3. t3_thread_launch：模型与 runtimeMode 取 t3-dispatch 配置，workspaceStrategy 为 worktree（repos[].baseRef，startFromOrigin），
//      clientRequestId = t3-dispatch-<主问题 ID>-<认领时间>，重试不会建出第二个线程；
//   4. 每个 id 记账（record）；
//   5. 回读：每 10 秒读一次，最多 90 秒，直到 run 进入 starting/running 且有 worktreePath。
// 建线程报错、或线程/run 已失败时归还本条认领的全部问题。90 秒后仍在 preparing/queued 不算失败（大仓库建工作树就要这么久）：
// 认领与台账保留，输出 pending，下一轮巡检按候选核对；归还会把已经开工的问题状态改回去。
// --dry-run 只校验计划格式（仓库在配置里、字段齐全），不认领不建线程。
// 输出 [{ title, ids, claimed, link, threadId, status, worktreePath, pending, duplicate, error, released }]；有失败时退出码 1。

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./dispatch-config.mjs";
import { run } from "./issue-source.mjs";
import { call, connect, hasSession, NO_SESSION } from "../../t3-patrol/scripts/t3-mcp.mjs";

export function validatePlan(plan, config) {
  const errors = [];
  if (!Array.isArray(plan?.launches) || !plan.launches.length) errors.push("计划里没有 launches");
  for (const [i, l] of (plan?.launches ?? []).entries()) {
    const at = `launches[${i}]`;
    if (!config.repos.some((r) => r.repo === String(l.repo ?? "").toLowerCase())) errors.push(`${at}.repo：${l.repo} 不在 t3-dispatch.json 的 repos 里`);
    if (!Array.isArray(l.ids) || !l.ids.length || !l.ids.every((x) => typeof x === "string" && x)) errors.push(`${at}.ids：须为非空的问题 ID 数组`);
    for (const k of ["environmentId", "projectId", "title", "reason"]) if (typeof l[k] !== "string" || !l[k].trim()) errors.push(`${at}.${k}：缺失`);
  }
  return errors;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAILED = new Set(["failed", "interrupted", "cancelled"]);
const READY = new Set(["starting", "running", "completed"]);
const refRe = (ref) => new RegExp(`(^|[^\\w-])${String(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");

// 各可达环境里该仓库的项目，按仓库缓存。
const scopeCache = new Map();
async function scopesOf(repo) {
  if (scopeCache.has(repo)) return scopeCache.get(repo);
  const links = await call("t3_environment_links", {});
  const envs = [null, ...(links.links ?? []).filter((x) => x.status === "reachable").map((x) => x.environmentId)];
  const scopes = [];
  for (const environmentId of envs) {
    const r = await call("t3_project_list", { limit: 100, ...(environmentId ? { environmentId } : {}) }).catch(() => null);
    for (const p of r?.projects ?? []) if (p.repositoryIdentity?.canonicalKey?.toLowerCase() === repo) scopes.push({ ...(environmentId ? { environmentId } : {}), projectId: p.id });
  }
  scopeCache.set(repo, scopes);
  return scopes;
}

// 只认标题或任务书命中：代理在别的线程里顺口提到这个编号不算在做它。
export async function openThreadFor(ref, repo) {
  for (const s of await scopesOf(repo)) {
    const res = await call("t3_thread_search", { ...s, query: ref, limit: 5 }).catch(() => null);
    const t = (res?.matches ?? []).find((x) => x.source !== "assistant" && refRe(ref).test(`${x.title ?? ""} ${x.snippet ?? ""}`));
    if (t) return t;
  }
  return null;
}

const READBACK_STEP_MS = Number(process.env.T3_DISPATCH_READBACK_STEP_MS ?? 10000);
const READBACK_MAX_MS = Number(process.env.T3_DISPATCH_READBACK_MAX_MS ?? 90000);

async function launchOne(l, config, dir) {
  const repoCfg = config.repos.find((r) => r.repo === l.repo.toLowerCase());
  const out = { title: l.title, ids: l.ids, claimed: [], environmentId: l.environmentId };
  const releaseAll = () => {
    out.released = [];
    for (const id of out.claimed) {
      try {
        out.released.push(run("release", { repo: l.repo, id }));
      } catch (e) {
        out.released.push({ id, error: String(e.message ?? e) });
      }
    }
  };
  try {
    const ref = run("show", { repo: l.repo, id: l.ids[0] }).ref;
    const dup = ref && (await openThreadFor(ref, l.repo.toLowerCase()));
    if (dup) return { ...out, duplicate: { title: dup.title, link: dup.link }, error: `${ref} 已有未结线程「${dup.title}」，跳过` };
  } catch (e) {
    return { ...out, error: `查重失败：${e.message}` };
  }
  let at;
  for (const [i, id] of l.ids.entries()) {
    try {
      const c = run("claim", { repo: l.repo, id });
      out.claimed.push(id);
      if (i === 0) at = c.at;
    } catch (e) {
      if (i === 0) return { ...out, error: `主问题认领失败：${e.message}` };
      (out.claimErrors ??= []).push({ id, error: String(e.message ?? e) });
    }
  }
  let threadId;
  try {
    const reasonFile = join(dir, `${l.ids[0]}.txt`);
    writeFileSync(reasonFile, l.reason, "utf8");
    const { message } = run("render", { repo: l.repo, id: l.ids[0], "reason-file": reasonFile });
    const r = await call("t3_thread_launch", {
      environmentId: l.environmentId,
      projectId: l.projectId,
      title: l.title,
      modelSelection: config.model,
      runtimeMode: config.runtimeMode,
      workspaceStrategy: { type: "worktree", baseRef: repoCfg.baseRef ?? "main", startFromOrigin: true },
      message,
      clientRequestId: `t3-dispatch-${l.ids[0]}-${at}`,
    });
    threadId = r.threadId;
    out.threadId = threadId;
    out.link = r.link;
  } catch (e) {
    out.error = `建线程失败：${e.message}`;
    releaseAll();
    return out;
  }
  for (const id of out.claimed) run("record", { repo: l.repo, id, env: l.environmentId, thread: threadId });
  for (let waited = 0; ; waited += READBACK_STEP_MS) {
    const h = await call("t3_thread_read", { environmentId: l.environmentId, threadId, limit: 1, maxCharsPerItem: 1 }).catch(() => null);
    out.status = h?.recentRuns?.[0]?.status ?? h?.thread?.status ?? null;
    out.worktreePath = h?.thread?.worktreePath ?? null;
    if (out.worktreePath && READY.has(out.status)) return out;
    if (FAILED.has(out.status) || FAILED.has(h?.thread?.status)) {
      out.error = `线程已建但 run ${out.status}，交给巡检按「工作树准备失败」恢复`;
      releaseAll();
      return out;
    }
    if (waited >= READBACK_MAX_MS) break;
    await sleep(READBACK_STEP_MS);
  }
  out.pending = `${READBACK_MAX_MS / 1000} 秒后仍是 ${out.status ?? "未知"}，工作树还在准备；认领与台账保留，下一轮巡检核对`;
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--plan");
  const file = i >= 0 ? args[i + 1] : null;
  if (!file) {
    console.error("用法：node dispatch-launch.mjs --plan <计划 JSON> [--dry-run]");
    process.exit(2);
  }
  try {
    const { config, errors: cfgErrors } = loadConfig();
    if (cfgErrors.length) throw new Error(cfgErrors.join("；"));
    const plan = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const errors = validatePlan(plan, config);
    if (errors.length) throw new Error(errors.join("\n"));
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify({ ok: true, launches: plan.launches.length }, null, 1));
      process.exit(0);
    }
    if (!hasSession()) throw new Error(NO_SESSION);
    await connect("t3-dispatch-launch");
    const dir = mkdtempSync(join(tmpdir(), "t3-dispatch-"));
    const results = [];
    try {
      for (const l of plan.launches) results.push(await launchOne(l, config, dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(JSON.stringify(results, null, 1));
    process.exit(results.some((r) => r.error) ? 1 : 0);
  } catch (e) {
    console.error(e.message);
    process.exit(e.message?.startsWith("用法") ? 2 : 1);
  }
}
