import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityOf, repoMatches, validateDevices } from "./patrol-capacity.mjs";

const CFG = { maxActiveThreads: 5, minFreeDiskGB: 20 };
const id = (canonicalKey, origin) => ({ canonicalKey, ...(origin ? { origin: { canonicalKey: origin } } : {}) });
const projects = new Map([
  ["p-musiver", id("fj.frp.musiver.cn/fjbobo/musiver")],
  ["p-doc", id("github.com/liuyincs/musiver")],
  ["p-tma", id("fj.frp.musiver.cn/fjbobo/tma")],
  ["p-skills", id("github.com/gitbobobo/skills")],
  ["p-t3", id("github.com/pingdotgg/t3code", "github.com/gitbobobo/t3code")],
  ["p-none", null],
]);
const MUSIVER = "fj.frp.musiver.cn/fjbobo/musiver";

test("仓库匹配：完整 key 精确比对，仓库名比对最后一段，含 fork 的 origin", () => {
  assert.ok(repoMatches("musiver", projects.get("p-musiver")));
  assert.ok(repoMatches("musiver", projects.get("p-doc")));
  assert.ok(repoMatches("FJ.frp.musiver.cn/fjbobo/musiver", projects.get("p-musiver")));
  assert.ok(!repoMatches(MUSIVER, projects.get("p-doc")));
  assert.ok(repoMatches("github.com/gitbobobo/t3code", projects.get("p-t3")));
  assert.ok(!repoMatches("musiver", null));
});

test("设备总上限缺省为各池之和，两个池可以同时用满；审查线程只计设备总数", () => {
  const device = { device: "pc", pools: [{ repos: [MUSIVER], max: 5 }, { repos: "*", max: 4 }] };
  const threads = [
    ...["a", "b", "c", "d"].map((title) => ({ title, projectId: "p-musiver" })),
    { title: "代码审查 · PR #1", projectId: "p-musiver", reviewBot: true },
  ];
  const c = capacityOf({ threads, projects, device, cfg: CFG });
  assert.equal(c.max, 9);
  assert.equal(c.free, 4);
  assert.deepEqual(c.pools.map((p) => [p.used, p.free]), [[4, 1], [0, 4]]);
  assert.equal(c.freeByRepo[MUSIVER], 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 4);
  assert.equal(c.freeOther, 4);
  assert.equal(capacityOf({ threads, projects, device: { ...device, maxActiveThreads: 6 }, cfg: CFG }).freeByRepo["github.com/gitbobobo/skills"], 1);
  const bare = capacityOf({ threads: [], projects, device: undefined, cfg: CFG });
  assert.deepEqual([bare.device, bare.max, bare.pools, bare.freeOther], [null, 5, [], 5]);
});

test("每个线程只进第一个匹配的池；没有池匹配的只占设备名额", () => {
  const device = { device: "mac-mini", maxActiveThreads: 6, pools: [{ repos: [MUSIVER], max: 2 }, { repos: ["tma", "musiver"], max: 2 }] };
  const threads = ["p-musiver", "p-musiver", "p-doc", "p-skills"].map((projectId, i) => ({ title: `t${i}`, projectId }));
  const c = capacityOf({ threads, projects, device, cfg: CFG });
  assert.deepEqual(c.pools.map((p) => p.occupying), [["t0", "t1"], ["t2"]]);
  assert.equal(c.freeByRepo[MUSIVER], 0);
  assert.equal(c.freeByRepo["fj.frp.musiver.cn/fjbobo/tma"], 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 2);
});

test("两道闸：本机磁盘低于保底或设备上有线程等资源时一律不建，名额照常计", () => {
  const device = { device: "pc", pools: [{ repos: [MUSIVER], max: 5 }, { repos: "*", max: 4 }] };
  const threads = [{ title: "a", projectId: "p-musiver" }];
  const ok = capacityOf({ threads, projects, device, cfg: CFG, diskFreeGB: 21 });
  assert.equal(ok.freeByRepo[MUSIVER], 4);
  assert.equal(ok.blocked, undefined);
  const low = capacityOf({ threads, projects, device, cfg: CFG, diskFreeGB: 19 });
  assert.deepEqual([low.freeByRepo[MUSIVER], low.freeOther, low.free], [0, 0, 8]);
  assert.match(low.blocked[0], /低于保底/);
  const remote = capacityOf({ threads, projects, device, cfg: CFG });
  assert.deepEqual([remote.disk.freeGB, remote.freeByRepo[MUSIVER]], [null, 4]);
  const waiting = capacityOf({ threads, projects, device, cfg: CFG, waiting: ["#20 构建"] });
  assert.equal(waiting.freeByRepo["github.com/gitbobobo/skills"], 0);
  assert.match(waiting.blocked[0], /#20 构建/);
});

test("设备配置校验：坏条目丢弃并报警告", () => {
  const warnings = [];
  const out = validateDevices([
    { device: "pc", pools: [{ repos: ["musiver"], max: 5, footprintGB: 30 }, { repos: [], max: 1 }, { repos: "*", max: -1 }] },
    { device: "pc", pools: [] },
    { pools: [] },
    { device: "linux", maxActiveThreads: 1.5 },
    { device: "mbp", maxActiveThreads: 3 },
  ], warnings);
  assert.deepEqual(out, [
    { device: "pc", pools: [{ repos: ["musiver"], max: 5 }] },
    { device: "mbp", maxActiveThreads: 3, pools: [] },
  ]);
  assert.equal(warnings.length, 6);
});
