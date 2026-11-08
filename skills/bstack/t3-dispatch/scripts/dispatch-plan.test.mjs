import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, rankOf } from "./dispatch-plan.mjs";
import { validatePlan } from "./dispatch-launch.mjs";

const MUS = "fj.frp.musiver.cn/fjbobo/musiver";
const TMA = "fj.frp.musiver.cn/fjbobo/tma";
const config = {
  limits: { perRun: 5, perDay: 20, maxAttempts: 2 },
  repos: [{ repo: MUS }, { repo: TMA, devices: ["mini"] }],
};
const environments = { pc: { environmentId: "e-pc" }, mini: { environmentId: "e-mini" } };
const env = (id, free, extra = {}) => ({
  environmentId: id,
  label: id,
  projects: [{ id: `${id}-mus`, canonicalKey: MUS }, { id: `${id}-tma`, canonicalKey: TMA }],
  capacity: { freeByRepo: { [MUS]: free[0], [TMA]: free[1] } },
  openThreads: [],
  ...extra,
});
const cand = (ref, title, extra = {}) => ({ id: `id-${ref}`, ref, title, labels: [], excerpt: "", updatedAt: "2026-11-01", ...extra });

test("粗排：崩溃先于构建先于体验，同类按高中低；未分类居中", () => {
  assert.equal(rankOf(cand("A", "播放页崩溃")).category, "无法使用/丢数据");
  assert.ok(rankOf(cand("A", "播放页崩溃")).rank < rankOf(cand("B", "门禁构建失败")).rank);
  assert.ok(rankOf(cand("B", "门禁构建失败")).rank < rankOf(cand("C", "按钮动画")).rank);
  assert.ok(rankOf(cand("D", "【高】按钮动画")).rank < rankOf(cand("E", "【低】按钮动画")).rank);
  const u = rankOf(cand("F", "某个说不清的事"));
  assert.equal(u.category, "未分类");
  assert.ok(u.rank > rankOf(cand("G", "保存失败")).rank && u.rank < rankOf(cand("H", "列表卡顿")).rank);
  assert.equal(rankOf(cand("I", "x", { excerpt: "待补信息：缺复现步骤" })).needsInfo, true);
  assert.equal(rankOf(cand("J", "【中】架构：认证客户端构建收成单一 module")).category, "架构重构");
  assert.equal(rankOf(cand("K", "清理未读的注入与死代码")).category, "架构重构");
});

test("没有空位时不列候选", () => {
  let listed = 0;
  const plan = buildPlan({
    capacity: { environments: [env("e-pc", [0, 0]), env("e-mini", [0, 0], { capacity: { freeByRepo: { [MUS]: 0, [TMA]: 0 }, blocked: ["有线程在等资源：x"] } })] },
    config,
    environments,
    ledger: [],
    listOf: () => (listed++, { candidates: [], skipped: [] }),
  });
  assert.equal(plan.slots, 0);
  assert.equal(listed, 0);
  assert.ok(plan.skipped.some((s) => /等资源/.test(s.reason)));
});

test("只为有空位的仓库列候选；devices 限定设备；查重排除未结线程与台账在派的问题；表长按空位", () => {
  const listCalls = [];
  const many = Array.from({ length: 12 }, (_, i) => cand(`INT-${100 + i}`, `第 ${i} 个功能错误`));
  const plan = buildPlan({
    capacity: {
      environments: [
        env("e-pc", [1, 3], { openThreads: [{ title: "INT-100 正在做", link: "<l>" }] }),
        env("e-mini", [0, 0]),
      ],
    },
    config,
    environments,
    ledger: [{ at: new Date().toISOString(), event: "launched", repo: MUS, id: "id-INT-101" }],
    listOf: (repo) => (listCalls.push(repo), { candidates: [cand("INT-99", "启动崩溃"), ...many], skipped: [{ ref: "x" }] }),
  });
  assert.deepEqual(listCalls, [MUS], "TMA 只允许 mini，mini 没空位，不列 TMA");
  const mus = plan.repos.find((r) => r.repo === MUS);
  assert.equal(plan.slots, 1);
  assert.deepEqual(mus.devices.map((d) => [d.environmentId, d.projectId, d.free]), [["e-pc", "e-pc-mus", 1]]);
  assert.deepEqual(mus.excluded.map((e) => e.ref).sort(), ["INT-100", "INT-101"]);
  assert.equal(mus.shortlist[0].ref, "INT-99", "崩溃排第一");
  assert.equal(mus.shortlist.length, 5);
  assert.equal(mus.more, 6);
  assert.equal(mus.sourceSkipped, 1);
});

test("perDay 余量封顶本轮可派数", () => {
  const ledger = Array.from({ length: 19 }, () => ({ at: new Date().toISOString(), event: "launched", repo: MUS, id: "z" }));
  const plan = buildPlan({ capacity: { environments: [env("e-pc", [4, 0])] }, config, environments, ledger, listOf: () => ({ candidates: [], skipped: [] }) });
  assert.equal(plan.slots, 1);
});

test("计划校验", () => {
  const cfg = { repos: [{ repo: MUS }] };
  assert.deepEqual(validatePlan({ launches: [{ repo: MUS, ids: ["a"], environmentId: "e", projectId: "p", title: "t", reason: "r" }] }, cfg), []);
  const errs = validatePlan({ launches: [{ repo: "x/y", ids: [], title: "t" }] }, cfg);
  assert.ok(errs.some((e) => /不在/.test(e)) && errs.some((e) => /ids/.test(e)) && errs.some((e) => /environmentId/.test(e)));
  assert.ok(validatePlan({}, cfg).length);
});
