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
test("当前和历史巡检、探测及 Fast Ship 审查均不占池", () => {
  const c = calc({ self: "self", threads: [...heavy,
    { title: "改过标题", threadId: "self", projectId: "l" },
    { title: "T3 巡检", projectId: "l" }, { title: "t3-patrol", projectId: "l" },
    { title: "额度探测", projectId: "l" },
    { title: "代码审查 · PR #1", projectId: "l" },
  ] });
  assert.equal(c.used, 4);
  assert.equal(c.freeByRepo[LIU], 2);
  assert.equal(countsCapacity({ title: "T3 巡检" }), false);
});
test("审查运行、有工作树或等待子代理均不占池；普通实现和重验证线程仍计数", () => {
  const reviews = [
    { title: "代码审查 · PR #208", projectId: "m", status: "running", worktreePath: "/tmp/review" },
    { title: "视觉审查 · PR #228", projectId: "t", status: "completed", hasLiveSubagents: true },
    { title: " 视觉审查 · PR #205  ", projectId: "l" },
  ];
  const regular = [
    { title: "INT-1 修复 Fast Ship 审查错误", projectId: "l" },
    { title: "#208 审查修复与重验证", projectId: "m" },
    { title: "代码审查 · PR #208 重验证", projectId: "m" },
    { title: "视觉审查 · PR #228 修复", projectId: "m" },
    { title: "已改名", projectId: "l", reviewBot: true },
    { title: "审查 #653 R4", projectId: "m" },
  ];
  assert.ok(reviews.every((t) => !countsCapacity(t)));
  assert.ok(regular.every((t) => countsCapacity(t)));
  const c = calc({ threads: [...reviews, ...regular] });
  assert.deepEqual(c.pools.map((p) => [p.name, p.used]), [["heavy", 4], ["general", 2]]);
  assert.equal(c.used, regular.length);
});
test("回放 Mini 历史快照：五个实现与三条审查只算五个重型名额", () => {
  const titles = ["代码审查 · PR #208", "#226 后台扫描-WebAndroid", "代码审查 · PR #228", "代码审查 · PR #205", "#210 发布列车-Android", "#228 收藏毫秒与顺序", "INT-1599 降级提示-Android", "INT-1695 播放会话-Android"];
  const c = calc({ device: { device: "mac-mini", pools: { heavy: 5, general: 2 } }, threads: titles.map((title) => ({ title, projectId: "m" })) });
  assert.equal(c.pools[0].used, 5);
  assert.equal(c.pools[0].free, 0);
  assert.equal(c.pools[0].occupying.length, 5);
  assert.equal(c.freeByRepo[LIU], 2);
  const released = calc({ device: { device: "mac-mini", pools: { heavy: 5 } }, threads: titles.slice(0, -1).map((title) => ({ title, projectId: "m" })) });
  assert.equal(released.freeByRepo[MUS], 1, "审查不能吞掉实现线程释放的名额");
});
test("设备只覆盖两池名额；缺身份进入通用池，显式general可覆盖fork origin", () => {
  const c = calc({ device: { device: "mini", pools: { heavy: 5, general: 1 } }, threads: [...heavy, { title: "无身份", projectId: "?" }] });
  assert.equal(c.freeByRepo[MUS], 1);
  assert.equal(c.freeOther, 0);
  assert.equal(c.poolByRepo[LIU], "general");
  const fork = new Map([["f", { canonicalKey: LIU, origin: { canonicalKey: MUS } }]]);
  assert.equal(calc({ projects: fork, cfg: { ...cfg, projects: [{ repo: LIU, pool: "general" }, ...cfg.projects] } }).poolByRepo[LIU], "general");
});
test("预计释放只抬高同池 projected，不改实际 free；闸住时两者都是 0", () => {
  const threads = heavy.map((t, i) => ({ ...t, threadId: `h${i}` }));
  const c = calc({ threads, releasing: new Set(["h0", "h1", "ghost"]) });
  assert.equal(c.freeByRepo[MUS], 0);
  assert.equal(c.projectedFreeByRepo[MUS], 1, "4 占 3 位，释放 2 个后余 1");
  assert.equal(c.projectedFreeByRepo[LIU], 2, "通用池不受重型释放影响");
  assert.deepEqual(c.pools[0].releasing, ["重型0", "重型1"]);
  assert.equal(calc({ threads }).projectedFreeByRepo, undefined, "没有预计释放时不输出 projected");
  assert.equal(calc({ threads, releasing: new Set(["h0", "h1"]), waiting: ["构建"] }).projectedFreeByRepo[MUS], 0);
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
