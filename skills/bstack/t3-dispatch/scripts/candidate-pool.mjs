#!/usr/bin/env node
// 派活题库：跨轮保存已研判的候选，不是认领台账。补货子代理按仓库写入，出队（dispatch-queue）与派出（dispatch-launch）移除。
// list [--repo <key>]：只读；validate --file <patch.json>：离线预检（revision 可省）；apply --repo <key> --file <patch.json>：带版本校验的原子更新。
// patch: { revision: <list 返回的 revision>, upsert: [...], remove: [id...] }；upsert 保留已有条目的位置，新条目追加在末尾，出队按数组顺序。
// 库存只算未过期（stock.maxAgeHours）的 ready 条目；每仓库最多 60 条。过期不自动删除，避免丢失阻塞与待核断点。
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../../t3-patrol/scripts/patrol-config.mjs";

export const MAX_PER_REPO = 60;
export const poolPath = (env = process.env) => join(configDir(env), "state", "t3-dispatch-candidates.json");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && !!v.trim();
const date = (v) => text(v) && Number.isFinite(Date.parse(v));
const repoKey = (v) => {
  if (!text(v) || !/^[^\s/]+\/[^\s/]+\/[^\s/]+$/.test(v)) throw new Error("repo 须为 host/owner/name");
  return v.toLowerCase();
};

export function validateCandidate(e) {
  if (!object(e)) throw new Error("候选须为对象");
  for (const k of ["id", "ref", "title", "scope", "reason", "nextCheck"]) if (!text(e[k])) throw new Error(`候选缺少 ${k}`);
  if (!["ready", "blocked", "pending"].includes(e.state)) throw new Error("state 须为 ready / blocked / pending");
  if (!["capacity", "priority", "dependency", "evidence"].includes(e.deferredBy)) throw new Error("deferredBy 须为 capacity / priority / dependency / evidence");
  if (e.state === "ready" && !["capacity", "priority"].includes(e.deferredBy)) throw new Error("ready 只能因容量或优先级暂缓");
  if (e.state === "blocked" && e.deferredBy !== "dependency") throw new Error("blocked 须记录 dependency；证据不足用 pending");
  if (e.state === "pending" && e.deferredBy !== "evidence") throw new Error("pending 须记录 evidence");
  if (!date(e.checkedAt)) throw new Error("checkedAt 须为日期");
  if (e.issueUpdatedAt !== null && !date(e.issueUpdatedAt)) throw new Error("issueUpdatedAt 须为日期或 null（未知时强制重核）");
  for (const k of ["devices", "evidenceRefs"]) if (!Array.isArray(e[k]) || !e[k].length || !e[k].every(text)) throw new Error(`${k} 须为非空字符串数组`);
  if (e.mergeIds !== undefined && !(Array.isArray(e.mergeIds) && e.mergeIds.every(text))) throw new Error("mergeIds 须为问题 ID 数组");
  if (e.threadTitle !== undefined && !text(e.threadTitle)) throw new Error("threadTitle 须为非空字符串");
  if (e.source === null) {
    if (e.state === "ready") throw new Error("ready 须带已核源码依据；source 未知时保留 pending 或 blocked，并在 nextCheck 写补证查询");
  } else if (!object(e.source) || !text(e.source.head) || !Array.isArray(e.source.paths) || !e.source.paths.length || !e.source.paths.every(text)) throw new Error("source 须带 head 与相关 paths；未核源码用 null");
  return e;
}

export function readPool(env = process.env) {
  let raw;
  try { raw = readFileSync(poolPath(env), "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const state = raw === undefined ? { version: 1, repos: {} } : JSON.parse(raw);
  if (state.version !== 1 || !object(state.repos)) throw new Error("候选池格式无效或版本不支持");
  for (const [repo, entries] of Object.entries(state.repos)) {
    if (repoKey(repo) !== repo || !Array.isArray(entries) || entries.length > MAX_PER_REPO) throw new Error(`候选池仓库无效：${repo}`);
    const ids = new Set();
    for (const e of entries) {
      validateCandidate(e);
      if (ids.has(e.id)) throw new Error(`候选池重复 ID：${e.id}`);
      ids.add(e.id);
    }
  }
  return { revision: createHash("sha256").update(raw ?? "").digest("hex"), state };
}

export const fresh = (e, now, maxAgeHours) => {
  const age = now - Date.parse(e.checkedAt);
  return age >= 0 && age <= maxAgeHours * 3600000;
};
export const stockOf = (entries, { now = Date.now(), maxAgeHours = 72 } = {}) => (entries ?? []).filter((e) => e.state === "ready" && fresh(e, now, maxAgeHours));

// 各仓库库存与缺口：目标 = multiplier × 仓库可派设备上所属池的名额之和。同池多仓库各自计目标，宁可多备不漏备。
// envs 取快照 environments（含 projects 与 capacity.pools/poolByRepo），environments 是 environments.json 别名表。
export function refillStatus({ repos, pool, envs, environments = {}, multiplier = 3, maxAgeHours = 72, now = Date.now() }) {
  const aliasOf = new Map(Object.entries(environments).map(([alias, e]) => [e.environmentId, alias]));
  return repos.map((r) => {
    const allowed = r.devices?.length ? new Set(r.devices.map((d) => environments[d]?.environmentId).filter(Boolean)) : null;
    const devices = [];
    const unknown = [];
    let capacity = 0;
    let poolName = null;
    for (const e of envs ?? []) {
      if (allowed && !allowed.has(e.environmentId)) continue;
      const project = (e.projects ?? []).find((p) => p.canonicalKey?.toLowerCase() === r.repo);
      if (!project) continue;
      const alias = aliasOf.get(e.environmentId) ?? e.label ?? e.environmentId;
      if (e.error || !e.capacity?.pools) {
        unknown.push(alias);
        continue;
      }
      poolName = e.capacity.poolByRepo?.[project.canonicalKey] ?? "general";
      capacity += e.capacity.pools.find((p) => p.name === poolName)?.max ?? 0;
      devices.push(alias);
    }
    const entries = pool?.repos?.[r.repo] ?? [];
    const stock = stockOf(entries, { now, maxAgeHours }).length;
    const target = Math.min(MAX_PER_REPO, multiplier * capacity);
    return { repo: r.repo, pool: poolName, devices, ...(unknown.length ? { unknownDevices: unknown } : {}), capacity, target, stock, deficit: Math.max(0, target - stock) };
  });
}

export function validatePatch(patch, { requireRevision = true } = {}) {
  if (!object(patch) || (requireRevision && !text(patch.revision)) || !Array.isArray(patch.upsert) || !Array.isArray(patch.remove) || !patch.remove.every(text)) throw new Error("补丁须带 revision（apply 时）、upsert 数组及 remove ID 数组");
  const ids = new Set(patch.remove);
  for (const e of patch.upsert) {
    validateCandidate(e);
    if (ids.has(e.id)) throw new Error(`补丁重复或冲突 ID：${e.id}`);
    ids.add(e.id);
  }
  if (new Set(patch.remove).size !== patch.remove.length) throw new Error("remove 含重复 ID");
  return patch;
}

export function applyPatch({ repo, patch, env = process.env }) {
  repo = repoKey(repo);
  validatePatch(patch);
  const file = poolPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try { fd = openSync(lock, "wx"); }
  catch (e) {
    if (e.code === "EEXIST") throw new Error(`候选池写锁已存在（活跃写入或崩溃遗留均可能）：${lock}。保留锁和原文件，不自动删除或轮询重试；确认活写者结束后重读 revision 再试，无活写者则列为维护阻塞`);
    throw e;
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const { revision, state } = readPool(env);
    if (patch.revision !== revision) throw new Error("候选池已变化；重读后合并补丁，保留其他项目与本轮新增项");
    // Map 保留插入顺序：已有条目原位更新，新条目追加，出队顺序因此稳定。
    const entries = new Map((state.repos[repo] ?? []).map((e) => [e.id, e]));
    for (const id of patch.remove) entries.delete(id);
    for (const e of patch.upsert) entries.set(e.id, e);
    if (entries.size > MAX_PER_REPO) throw new Error(`每仓库最多 ${MAX_PER_REPO} 条，先淘汰已解决、重复或低价值项`);
    state.repos[repo] = [...entries.values()];
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    return readPool(env);
  } finally {
    try { unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; }
    closeSync(fd);
    unlinkSync(lock);
  }
}

// 出队或派出后移除：每次重读 revision，版本冲突（补货子代理同时写入）重试一次。
export function removeIds({ repo, ids, env = process.env }) {
  if (!ids.length) return null;
  for (let attempt = 0; ; attempt++) {
    const { revision, state } = readPool(env);
    const present = new Set((state.repos[repoKey(repo)] ?? []).map((e) => e.id));
    const remove = [...new Set(ids)].filter((id) => present.has(id));
    if (!remove.length) return { revision, removed: [] };
    try {
      return { ...applyPatch({ repo, env, patch: { revision, upsert: [], remove } }), removed: remove };
    } catch (e) {
      if (attempt > 0 || !/已变化/.test(e.message)) throw e;
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [cmd = "list", ...args] = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--repo", "--file"].includes(args[i]) || !args[i + 1]) throw new Error(`参数无效：${args[i]}`);
      opts[args[i].slice(2)] = args[i + 1];
    }
    let result;
    if (cmd === "list") {
      result = readPool();
      if (opts.repo) { const repo = repoKey(opts.repo); result.state.repos = { [repo]: result.state.repos[repo] ?? [] }; }
    } else if (cmd === "validate" && opts.file) {
      const patch = validatePatch(JSON.parse(readFileSync(opts.file, "utf8")), { requireRevision: false });
      result = { valid: true, upsert: patch.upsert.length, remove: patch.remove.length };
    } else if (cmd === "apply" && opts.repo && opts.file) {
      result = applyPatch({ repo: opts.repo, patch: JSON.parse(readFileSync(opts.file, "utf8")) });
    } else throw new Error("用法：candidate-pool.mjs list [--repo <key>] | validate --file <patch.json> | apply --repo <key> --file <patch.json>");
    console.log(JSON.stringify({ file: poolPath(), maxPerRepo: MAX_PER_REPO, ...result }, null, 1));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
