// 容量池：按设备、按仓库限制巡检新建线程。配置在 t3-patrol.json 的 capacity.devices：
//   [{ "device": "<environments.json 里的别名>", "maxActiveThreads"?: n, "pools": [{ "repos": ["musiver"] | "*", "max": n }] }]
// 设备总上限缺省取 capacity.maxActiveThreads。每个占用线程只落进第一个匹配的池；没有池匹配的只受设备总上限约束。
// 审查线程（「代码审查 / 视觉审查 · PR #N」）只计设备总数，不占仓库池。
//
// repos 里写带 "/" 的完整 canonicalKey（如 fj.frp.musiver.cn/fjbobo/musiver）按全名比对；
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
// freeByRepo 按该环境各项目的 canonicalKey 给出可新建数（设备空位与所属池空位取小）；
// freeOther 适用于不在表里的项目（没有仓库身份），按「*」池或设备空位算。
export function capacityOf({ threads, projects, device, maxActiveThreads }) {
  const max = device?.maxActiveThreads ?? maxActiveThreads;
  const pools = (device?.pools ?? []).map((p) => ({ repos: p.repos, max: p.max, used: 0, occupying: [] }));
  for (const t of threads) {
    if (t.reviewBot) continue;
    const i = poolIndexOf(pools, projects.get(t.projectId) ?? null);
    if (i < 0) continue;
    pools[i].used++;
    pools[i].occupying.push(t.title);
  }
  for (const p of pools) p.free = Math.max(0, p.max - p.used);
  const capacity = { device: device?.device ?? null, max, used: threads.length, free: Math.max(0, max - threads.length), pools };
  const freeByRepo = {};
  for (const id of projects.values()) if (id?.canonicalKey) freeByRepo[id.canonicalKey] = freeFor(capacity, id);
  return { ...capacity, freeByRepo, freeOther: freeFor(capacity, null) };
}

export function freeFor(capacity, identity) {
  const i = poolIndexOf(capacity.pools, identity);
  return i < 0 ? capacity.free : Math.min(capacity.free, capacity.pools[i].free);
}
