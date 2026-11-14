// 两个独立容量池：项目归属统一配置，每台设备只覆盖 heavy/general 的名额。
const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
export const POOLS = ["heavy", "general"];

export function validatePools(value, defaults, warnings = [], path = "capacity.pools") {
  const out = { ...defaults };
  for (const [name, max] of Object.entries(value ?? {})) {
    if (!POOLS.includes(name) || !isCount(max)) warnings.push(`${path}.${name}：须为 heavy/general 的非负整数名额，沿用默认值`);
    else out[name] = max;
  }
  return out;
}

export function validateDevices(devices, warnings = []) {
  const out = [], seen = new Set();
  for (const [i, d] of (devices ?? []).entries()) {
    const at = `capacity.devices[${i}]`;
    if (kind(d) !== "object" || typeof d.device !== "string" || !d.device || seen.has(d.device)) {
      warnings.push(`${at}：须带唯一的设备别名 device，已忽略`);
      continue;
    }
    for (const key of Object.keys(d)) if (!["device", "pools"].includes(key)) warnings.push(`${at}.${key}：未知配置项，已忽略`);
    seen.add(d.device);
    if (d.pools !== undefined && kind(d.pools) !== "object") {
      warnings.push(`${at}.pools：应为 { heavy, general }，已忽略该设备`);
      continue;
    }
    out.push({ device: d.device, pools: validatePools(d.pools, {}, warnings, `${at}.pools`) });
  }
  return out;
}

export function validateProjects(projects, warnings = []) {
  const out = [], seen = new Set();
  for (const [i, p] of (projects ?? []).entries()) {
    if (kind(p) !== "object" || typeof p.repo !== "string" || !p.repo.includes("/") || !POOLS.includes(p.pool) || seen.has(p.repo.toLowerCase())) {
      warnings.push(`capacity.projects[${i}]：须带唯一完整 repo 与 pool（heavy/general），已忽略`);
      continue;
    }
    seen.add(p.repo.toLowerCase());
    out.push({ repo: p.repo, pool: p.pool });
  }
  return out;
}

const keysOf = (identity) => [identity?.canonicalKey, identity?.origin?.canonicalKey].filter((k) => typeof k === "string").map((k) => k.toLowerCase());
export function repoMatches(pattern, identity) {
  const p = pattern.toLowerCase(), keys = keysOf(identity);
  return p.includes("/") ? keys.includes(p) : keys.some((k) => k.split("/").at(-1) === p);
}
export const poolOf = (identity, cfg) => (cfg.projects ?? []).find((p) => repoMatches(p.repo, identity))?.pool ?? "general";
// 当前巡检靠身份排除；其他巡检按约定标题识别，额度/资源探测也不占池。
export const isPatrol = (t, self = null) => (self != null && (t.threadId ?? t.id) === self) || /巡检|t3-patrol/i.test(String(t.title ?? ""));
export const countsCapacity = (t, self = null) => !isPatrol(t, self) && !/^(?:额度|资源)探测$/.test(String(t.title ?? "").trim());

export function capacityOf({ threads, projects, device, cfg, diskFreeGB = null, waiting = [], self = null }) {
  const limits = { ...cfg.pools, ...device?.pools };
  const pools = POOLS.map((name) => ({ name, max: limits[name], used: 0, free: 0, occupying: [] }));
  const counted = threads.filter((t) => countsCapacity(t, self));
  for (const t of counted) {
    const p = pools.find((p) => p.name === poolOf(projects.get(t.projectId), cfg));
    p.used++;
    p.occupying.push(t.title);
  }
  for (const p of pools) p.free = Math.max(0, p.max - p.used);
  const blocked = [];
  if (diskFreeGB !== null && diskFreeGB < cfg.minFreeDiskGB) blocked.push(`本机磁盘剩 ${diskFreeGB} GB，低于保底 ${cfg.minFreeDiskGB} GB`);
  if (waiting.length) blocked.push(`有线程在等资源：${waiting.join("、")}`);
  const freeAt = (identity) => blocked.length ? 0 : pools.find((p) => p.name === poolOf(identity, cfg)).free;
  return {
    device: device?.device ?? null,
    used: counted.length,
    pools,
    disk: { freeGB: diskFreeGB, minFreeGB: cfg.minFreeDiskGB },
    ...(blocked.length ? { blocked } : {}),
    freeByRepo: Object.fromEntries([...projects.values()].filter((id) => id?.canonicalKey).map((id) => [id.canonicalKey, freeAt(id)])),
    poolByRepo: Object.fromEntries([...projects.values()].filter((id) => id?.canonicalKey).map((id) => [id.canonicalKey, poolOf(id, cfg)])),
    freeOther: freeAt(null),
  };
}
