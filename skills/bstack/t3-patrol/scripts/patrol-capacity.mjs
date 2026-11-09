// 容量：巡检新建线程（交接、派活）前，按设备并发上限与仓库池算出各仓库还能建几个。
//
// 配置在 t3-patrol.json 的 capacity：
//   devices: [{ "device": "<environments.json 别名>", "maxActiveThreads"?: n,
//               "pools": [{ "repos": ["musiver"] | "*", "max": n }] }]
//   设备总上限缺省为各池 max 之和（池可以同时用满）；没配池的设备取 capacity.maxActiveThreads。
// 每个占用线程只落进第一个匹配的池；没有池匹配的只受设备总上限约束。
// 审查线程（「代码审查 / 视觉审查 · PR #N」）只计设备总数，不占池。
//
// 巡检只管名额。磁盘、内存与负载由干活的线程在重验证前自己检查（t3-orchestrator 的 resource-check.mjs），
// 不够时它停下并留 `【等待资源】` 标记。这里只做两道闸：
//   - 本机磁盘（快照直接量）低于 minFreeDiskGB：本机不建；
//   - 设备上有线程在等资源：这台设备不建，直到它恢复。
//
// repos 写带 "/" 的完整 canonicalKey（如 fj.frp.musiver.cn/fjbobo/musiver）按全名比对；
// 只写仓库名时比对 canonicalKey 的最后一段，可能同时命中不同宿主上的同名仓库。均不区分大小写，也比对 fork 的 origin。

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

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
      if (kind(p) !== "object" || !okRepos || !isCount(p.max)) {
        warnings.push(`${at}.pools[${j}]：须为 { repos: [仓库…] 或 "*", max: 非负整数 }，已忽略`);
        continue;
      }
      if (p.footprintGB !== undefined) warnings.push(`${at}.pools[${j}].footprintGB：磁盘改由实现线程自查，此键已不再使用，可删除`);
      pools.push({ repos: p.repos === "*" ? "*" : [...p.repos], max: p.max });
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

// threads: 占用名额的顶层线程 [{ title, projectId, reviewBot }]；projects: Map<projectId, repositoryIdentity|null>
// cfg: 生效配置的 capacity；diskFreeGB: 本机实测值，远程为 null；waiting: 本设备在等资源的线程标题。
export function capacityOf({ threads, projects, device, cfg, diskFreeGB = null, waiting = [] }) {
  const pools = (device?.pools ?? []).map((p) => ({ repos: p.repos, max: p.max, used: 0, free: 0, occupying: [] }));
  const max = device?.maxActiveThreads ?? (pools.length ? pools.reduce((s, p) => s + p.max, 0) : cfg.maxActiveThreads);
  for (const t of threads) {
    if (t.reviewBot) continue;
    const i = poolIndexOf(pools, projects.get(t.projectId) ?? null);
    if (i >= 0) {
      pools[i].used++;
      pools[i].occupying.push(t.title);
    }
  }
  for (const p of pools) p.free = Math.max(0, p.max - p.used);
  const free = Math.max(0, max - threads.length);
  const blocked = [];
  if (diskFreeGB !== null && diskFreeGB < cfg.minFreeDiskGB) blocked.push(`本机磁盘剩 ${diskFreeGB} GB，低于保底 ${cfg.minFreeDiskGB} GB`);
  if (waiting.length) blocked.push(`有线程在等资源：${waiting.join("、")}`);
  const freeAt = (i) => (blocked.length ? 0 : i < 0 ? free : Math.min(free, pools[i].free));
  const freeByRepo = {};
  for (const id of projects.values()) if (id?.canonicalKey) freeByRepo[id.canonicalKey] = freeAt(poolIndexOf(pools, id));
  return {
    device: device?.device ?? null,
    max,
    used: threads.length,
    free,
    pools,
    disk: { freeGB: diskFreeGB, minFreeGB: cfg.minFreeDiskGB },
    ...(blocked.length ? { blocked } : {}),
    freeByRepo,
    freeOther: freeAt(poolIndexOf(pools, null)),
  };
}
