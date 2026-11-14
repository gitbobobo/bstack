import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityOf, countsCapacity, validateDevices, validateProjects, validatePools } from "./patrol-capacity.mjs";
const MUS = "fj.frp.musiver.cn/fjbobo/musiver", TMA = "fj.frp.musiver.cn/fjbobo/tma", LIU = "fj.frp.musiver.cn/fjbobo/liuyin";
const projects = new Map([["m", { canonicalKey: MUS }], ["t", { canonicalKey: TMA }], ["l", { canonicalKey: LIU }]]);
const cfg = { pools: { heavy: 3, general: 2 }, projects: [{ repo: MUS, pool: "heavy" }, { repo: TMA, pool: "heavy" }], minFreeDiskGB: 20 };
const heavy = Array.from({ length: 4 }, (_, i) => ({ title: `重型${i}`, projectId: i % 2 ? "t" : "m" }));
const calc = (args = {}) => capacityOf({ threads: heavy, projects, cfg, ...args });

test("重型超额不挤占通用池；Musiver/TMA共享重型池；没有设备总上限", () => {
  const c = calc();
  assert.equal(c.freeByRepo[MUS], 0);
  assert.equal(c.freeByRepo[TMA], 0);
  assert.equal(c.freeByRepo[LIU], 2);
  assert.equal(c.max, undefined);
  assert.equal(c.free, undefined);
  assert.deepEqual(c.pools.map((p) => [p.name, p.used, p.free]), [["heavy", 4, 0], ["general", 0, 2]]);
});
test("当前和历史巡检、探测都不计数，审查线程跟随项目归属", () => {
  const c = calc({ self: "self", threads: [...heavy,
    { title: "改过标题", threadId: "self", projectId: "l" },
    { title: "T3 巡检", projectId: "l" }, { title: "t3-patrol", projectId: "l" },
    { title: "额度探测", projectId: "l" },
    { title: "代码审查 · PR #1", projectId: "l", reviewBot: true },
  ] });
  assert.equal(c.used, 5);
  assert.equal(c.freeByRepo[LIU], 1);
  assert.equal(countsCapacity({ title: "T3 巡检" }), false);
});
test("设备只覆盖两池名额；缺身份进入通用池，显式general可覆盖fork origin", () => {
  const c = calc({ device: { device: "mini", pools: { heavy: 5, general: 1 } }, threads: [...heavy, { title: "无身份", projectId: "?" }] });
  assert.equal(c.freeByRepo[MUS], 1);
  assert.equal(c.freeOther, 0);
  assert.equal(c.poolByRepo[LIU], "general");
  const fork = new Map([["f", { canonicalKey: LIU, origin: { canonicalKey: MUS } }]]);
  assert.equal(calc({ projects: fork, cfg: { ...cfg, projects: [{ repo: LIU, pool: "general" }, ...cfg.projects] } }).poolByRepo[LIU], "general");
});
test("磁盘/等待资源仍闸住两池", () => {
  for (const args of [{ diskFreeGB: 19 }, { waiting: ["构建"] }]) {
    const c = calc(args);
    assert.equal(c.freeByRepo[LIU], 0);
    assert.equal(c.freeOther, 0);
    assert.equal(c.blocked.length, 1);
  }
  assert.equal(calc({ diskFreeGB: 21 }).freeByRepo[LIU], 2);
});
test("校验拒绝旧池数组、设备总上限、重复项目与非法名额", () => {
  const w = [];
  assert.deepEqual(validateDevices([{ device: "pc", pools: { heavy: 4, general: 2 } }, { device: "old", pools: [] }, { device: "pc" }, { device: "x", maxActiveThreads: 1 }], w), [{ device: "pc", pools: { heavy: 4, general: 2 } }, { device: "x", pools: {} }]);
  assert.equal(w.length, 3);
  assert.deepEqual(validateProjects([{ repo: MUS, pool: "heavy" }, { repo: MUS, pool: "general" }, { repo: "tma", pool: "heavy" }], w), [{ repo: MUS, pool: "heavy" }]);
  assert.deepEqual(validatePools({ heavy: -1, general: 0, other: 1 }, cfg.pools, w), { heavy: 3, general: 0 });
});
