// 容量：巡检新建线程前，按设备并发上限、仓库池与磁盘余量算出各仓库还能建几个。
//
// 配置在 t3-patrol.json 的 capacity：
//   devices: [{ "device": "<environments.json 别名>", "maxActiveThreads"?: n,
//               "pools": [{ "repos": ["musiver"] | "*", "max": n, "footprintGB"?: x }] }]
//   设备总上限缺省为各池 max 之和（池可以同时用满）；没配池的设备取 capacity.maxActiveThreads。
//   footprintGB 是该池一个线程的峰值磁盘占用（工作树加构建产物），缺省取 capacity.defaultFootprintGB。
// 每个占用线程只落进第一个匹配的池；没有池匹配的只受设备总上限约束。
// 审查线程（「代码审查 / 视觉审查 · PR #N」）只计设备总数，不占池，也不预留磁盘。
//
// 磁盘：可用空间 = 剩余 − minFreeDiskGB − 在建预留。growthWindowHours 内新建的线程多半还没构建完，
// 按所在池的 footprintGB 预留；可建数 = floor(可用空间 / footprintGB)。footprintGB 为 0 时只要求可用空间不为负。
// 远程环境的剩余空间要靠资源探测取得，取到前 disk.freeGB 为 null，freeByRepo 只反映名额。
//
// repos 写带 "/" 的完整 canonicalKey（如 fj.frp.musiver.cn/fjbobo/musiver）按全名比对；
// 只写仓库名时比对 canonicalKey 的最后一段，可能同时命中不同宿主上的同名仓库。均不区分大小写，也比对 fork 的 origin。
//
// CLI（远程探测后重算）：node patrol-capacity.mjs --snapshot <快照> --env <environmentId|别名> --disk-free <GB>

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isSize = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

// 坏条目丢弃并报警告：拼错的设备或池静默生效会放出超额线程。
export function validateDevices(devices, warnings = []) {
  const out = [];
  const seen = new Set();
  for (const [i, d] of (devices ?? []).entries()) {
    const at = `capacity.devices[${i}]`;
    if (kind(d) !== "object" || typeof d.device !== "string" || !d.device) {
      warnings.push(`${at}：须带字符串 device（environments.json 的别名），已忽略`);
      continue;
    }
    if (seen.has(d.device)) {
      warnings.push(`${at}：设备 ${d.device} 重复，已忽略`);
      continue;
    }
    if (d.maxActiveThreads !== undefined && !isCount(d.maxActiveThreads)) {
      warnings.push(`${at}.maxActiveThreads：应为非负整数，已忽略该设备`);
      continue;
    }
    const pools = [];
    for (const [j, p] of (kind(d.pools) === "array" ? d.pools : []).entries()) {
      const okRepos = p?.repos === "*" || (kind(p?.repos) === "array" && p.repos.length > 0 && p.repos.every((r) => typeof r === "string" && r));
      if (kind(p) !== "object" || !okRepos || !isCount(p.max) || (p.footprintGB !== undefined && !isSize(p.footprintGB))) {
        warnings.push(`${at}.pools[${j}]：须为 { repos: [仓库…] 或 "*", max: 非负整数, footprintGB?: 非负数 }，已忽略`);
        continue;
      }
      pools.push({ repos: p.repos === "*" ? "*" : [...p.repos], max: p.max, ...(p.footprintGB !== undefined ? { footprintGB: p.footprintGB } : {}) });
    }
    if (d.pools !== undefined && kind(d.pools) !== "array") warnings.push(`${at}.pools：应为数组，已忽略`);
    seen.add(d.device);
    out.push({ device: d.device, ...(d.maxActiveThreads !== undefined ? { maxActiveThreads: d.maxActiveThreads } : {}), pools });
  }
  return out;
}

const keysOf = (identity) =>
  [identity?.canonicalKey, identity?.origin?.canonicalKey].filter((k) => typeof k === "string").map((k) => k.toLowerCase());

export function repoMatches(pattern, identity) {
  const p = pattern.toLowerCase();
  const keys = keysOf(identity);
  return p.includes("/") ? keys.includes(p) : keys.some((k) => k.split("/").at(-1) === p);
}

export const poolIndexOf = (pools, identity) =>
  pools.findIndex((p) => p.repos === "*" || p.repos.some((r) => repoMatches(r, identity)));

// threads: 占用名额的顶层线程 [{ title, projectId, reviewBot, createdAt, worktree? }]；projects: Map<projectId, repositoryIdentity|null>
// cfg: 生效配置的 capacity；diskFreeGB: 本机实测值，远程为 null。
export function capacityOf({ threads, projects, device, cfg, diskFreeGB = null, now = Date.now() }) {
  const footprint = (p) => p?.footprintGB ?? cfg.defaultFootprintGB;
  const pools = (device?.pools ?? []).map((p) => ({ repos: p.repos, max: p.max, footprintGB: footprint(p), used: 0, free: 0, occupying: [] }));
  const max = device?.maxActiveThreads ?? (pools.length ? pools.reduce((s, p) => s + p.max, 0) : cfg.maxActiveThreads);
  let reserveGB = 0;
  const growing = [];
  for (const t of threads) {
    if (t.reviewBot) continue;
    const i = poolIndexOf(pools, projects.get(t.projectId) ?? null);
    if (i >= 0) {
      pools[i].used++;
      pools[i].occupying.push(t.title);
    }
    // 没有工作树的线程（巡检、调研对话）不吃磁盘；worktree 未知时按有算，宁可少建。
    const age = now - Date.parse(t.createdAt ?? "");
    if (t.worktree !== false && age >= 0 && age < cfg.growthWindowHours * 3600 * 1000) {
      reserveGB += i >= 0 ? pools[i].footprintGB : cfg.defaultFootprintGB;
      growing.push(t.title);
    }
  }
  for (const p of pools) p.free = Math.max(0, p.max - p.used);
  const repoPool = {};
  for (const id of projects.values()) if (id?.canonicalKey) repoPool[id.canonicalKey] = poolIndexOf(pools, id);
  const base = {
    device: device?.device ?? null,
    max,
    used: threads.length,
    free: Math.max(0, max - threads.length),
    pools,
    otherPool: poolIndexOf(pools, null),
    repoPool,
    disk: { freeGB: null, minFreeGB: cfg.minFreeDiskGB, reserveGB, growing, defaultFootprintGB: cfg.defaultFootprintGB },
  };
  return withDisk(base, diskFreeGB);
}

// 名额与磁盘各算一个上限取小。diskFreeGB 为 null 时只按名额，并保留 disk.freeGB=null 提醒先探测。
export function withDisk(capacity, diskFreeGB) {
  const disk = { ...capacity.disk, freeGB: diskFreeGB };
  const spare = diskFreeGB === null ? null : diskFreeGB - disk.minFreeGB - disk.reserveGB;
  disk.spareGB = spare === null ? null : Math.round(spare * 10) / 10;
  const roomFor = (fp) => (spare === null ? Infinity : fp > 0 ? Math.max(0, Math.floor(spare / fp)) : spare >= 0 ? Infinity : 0);
  const freeAt = (i) => {
    const slots = i < 0 ? capacity.free : Math.min(capacity.free, capacity.pools[i].free);
    return Math.min(slots, roomFor(i < 0 ? disk.defaultFootprintGB : capacity.pools[i].footprintGB));
  };
  const freeByRepo = Object.fromEntries(Object.entries(capacity.repoPool).map(([k, i]) => [k, freeAt(i)]));
  return { ...capacity, disk, freeByRepo, freeOther: freeAt(capacity.otherPool) };
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [file, env, free] = [opt("snapshot"), opt("env"), Number(opt("disk-free"))];
  if (!file || !env || !Number.isFinite(free)) {
    console.error("用法：node patrol-capacity.mjs --snapshot <快照> --env <environmentId|别名> --disk-free <GB>");
    process.exit(2);
  }
  const snap = JSON.parse(readFileSync(file, "utf8"));
  const e = (snap.environments ?? []).find((x) => x.environmentId === env || x.alias === env);
  if (!e?.capacity) {
    console.error(`快照里没有环境 ${env} 的 capacity`);
    process.exit(2);
  }
  console.log(JSON.stringify(withDisk(e.capacity, free), null, 1));
}
