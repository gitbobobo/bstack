import { test } from "node:test";
import assert from "node:assert/strict";
import { briefName, buildPlan, rankOf, repoBriefOf, selectionOf } from "./dispatch-plan.mjs";
import { validateCandidate } from "./candidate-pool.mjs";
import { capacityErrors, validatePlan, launchConfigFor } from "./dispatch-launch.mjs";

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
const NOW = Date.parse("2026-11-02T00:00:00Z");
const saved = (c, extra = {}) => validateCandidate({
  id: c.id, ref: c.ref, title: c.title, state: "ready", deferredBy: "capacity",
  scope: "独立交付范围", reason: "仅缺空位", nextCheck: "确认来源、源码与设备分工未变",
  issueUpdatedAt: c.updatedAt, checkedAt: new Date(NOW).toISOString(),
  source: { head: "abc", paths: ["src"] }, devices: ["pc"], evidenceRefs: ["issue:1"], ...extra,
});

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

test("只为有空位的仓库列候选；devices 限定设备；标题命中仅作线索，台账在派仍排除；表长按空位", () => {
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
  assert.deepEqual(mus.excluded.map((e) => e.ref).sort(), ["INT-101"]);
  assert.equal(mus.shortlist.find((c) => c.ref === "INT-100").threadMatch.link, "<l>");
  assert.equal(mus.shortlist[0].ref, "INT-99", "崩溃排第一");
  assert.equal(mus.shortlist.length, 5);
  assert.equal(mus.more, 7);
  assert.equal(mus.sourceSkipped, 1);
});

test("perDay 余量封顶本轮可派数", () => {
  const ledger = Array.from({ length: 19 }, () => ({ at: new Date().toISOString(), event: "launched", repo: MUS, id: "z" }));
  const plan = buildPlan({ capacity: { environments: [env("e-pc", [4, 0])] }, config, environments, ledger, listOf: () => ({ candidates: [], skipped: [] }) });
  assert.equal(plan.slots, 1);
  const unlimited = buildPlan({ capacity: { environments: [env("e-pc", [4, 0])] }, config: { ...config, limits: { ...config.limits, perDay: 0 } }, environments, ledger, listOf: () => ({ candidates: [], skipped: [] }) });
  assert.equal(unlimited.slots, 4, "perDay 为 0 不限，只受名额与 perRun 约束");
});

test("旧候选依据单列，新高优先问题仍进入初筛；保留版本供跨轮复核", () => {
  const old = cand("INT-1", "播放失败");
  const urgent = cand("INT-2", "启动崩溃", { labels: ["bstack:priority"] });
  const p = buildPlan({ capacity: { environments: [env("e-pc", [1, 0])] }, config, environments, ledger: [],
    candidatePool: { [MUS]: [saved(old)] }, now: NOW,
    listOf: () => ({ candidates: [old, urgent], skipped: [] }),
  });
  assert.equal(p.repos[0].reviewed[0].id, old.id);
  assert.equal(p.repos[0].reviewed[0].cachedReview.reuseEvidence, true);
  assert.deepEqual(p.repos[0].shortlist.map((c) => c.id), [urgent.id]);
  assert.equal(p.repos[0].shortlist[0].updatedAt, urgent.updatedAt);
  assert.equal(p.slots, 1, "缓存不增加容量");
});

test("变化、过期、阻塞、证据不足或设备不匹配的缓存回到初筛", () => {
  const old = cand("INT-1", "播放失败");
  for (const extra of [
    { issueUpdatedAt: "2026-10-01" }, { checkedAt: "2026-10-01" },
    { state: "blocked", deferredBy: "dependency" }, { state: "pending", deferredBy: "evidence" },
    { devices: ["mini"] },
  ]) {
    const p = buildPlan({ capacity: { environments: [env("e-pc", [1, 0])] }, config, environments, ledger: [],
      candidatePool: { [MUS]: [saved(old, extra)] }, now: NOW,
      listOf: () => ({ candidates: [old], skipped: [] }),
    });
    assert.equal(p.repos[0].reviewed.length, 0);
    assert.equal(p.repos[0].shortlist[0].cachedReview.reuseEvidence, false);
  }
});

test("缓存仍保留标题线索，不能绕过实时准入、台账和暂缓标签", () => {
  const cs = [1, 2, 3, 4, 5].map((i) => cand(`INT-${i}`, "播放失败"));
  cs[2].labels = ["bstack:defer"];
  const p = buildPlan({ capacity: { environments: [env("e-pc", [1, 0], { openThreads: [{ title: "INT-1 已在做" }] })] }, config, environments,
    ledger: [{ event: "launched", at: new Date(NOW).toISOString(), repo: MUS, id: cs[1].id }],
    candidatePool: { [MUS]: cs.map((c) => saved(c)) }, now: NOW,
    listOf: () => ({ candidates: cs.slice(0, 4), skipped: [] }),
  });
  assert.deepEqual(p.repos[0].reviewed.map((c) => c.ref), ["INT-1", "INT-4"]);
  assert.equal(p.repos[0].reviewed[0].threadMatch.title, "INT-1 已在做");
  assert.equal(p.repos[0].excluded.length, 2);
  assert.deepEqual(p.repos[0].poolMissing, [{ id: cs[4].id, ref: "INT-5" }]);
});

test("挑题前分工：多个待筛项目都委派，单项目大批也委派，小批与仅复用留主代理", () => {
  const repo = (name, count, slots = 1, reused = 0) => ({ repo: name, slots, devices: [{ alias: "pc" }],
    shortlist: Array.from({ length: Math.min(5, count) }, (_, i) => ({ id: `${name}-${i}` })), more: Math.max(0, count - 5),
    reviewed: Array.from({ length: reused }, (_, i) => ({ id: `${name}-old-${i}` })),
  });
  const choose = (repos, slots = 3) => selectionOf({ slots, repos }, "snapshot-before-selection");
  const multi = choose([repo(MUS, 6), repo(TMA, 5)]);
  assert.equal(multi.capacityAt, "snapshot-before-selection");
  assert.ok(multi.assignments.every((a) => a.mode === "delegate" && a.reason === "multiple_repos"));
  const large = choose([repo(MUS, 8)]).assignments[0];
  assert.equal(large.mode, "delegate");
  assert.equal(large.pendingCount, 8, "表外待筛项也决定工作量");
  assert.equal(choose([repo(MUS, 4)]).assignments[0].mode, "lead");
  assert.equal(choose([repo(MUS, 5)]).assignments[0].mode, "delegate", "批量阈值边界");
  const reused = choose([repo(MUS, 0, 1, 3)]).assignments[0];
  assert.equal(reused.reason, "reuse_evidence");
  assert.equal(reused.mode, "lead");
  assert.equal(choose([repo(MUS, 8, 0)]).assignments[0].mode, "skip");
  assert.equal(choose([repo(MUS, 8)], 0).assignments[0].mode, "skip");
  assert.equal(choose([repo(MUS, 0)]).assignments[0].reason, "no_candidates");
});

test("第182轮计划回放：读取计划即给出逐项目委派，不能等串行填满后再判", () => {
  const first = buildPlan({ capacity: { generatedAt: "2026-11-14T16:47:00Z", environments: [env("e-mini", [1, 1])] },
    config, environments, ledger: [], listOf: () => ({ candidates: [cand("INT-1", "修复功能错误")], skipped: [] }) });
  assert.equal(first.selection.capacityAt, "2026-11-14T16:47:00Z");
  assert.ok(first.selection.assignments.every((a) => a.mode === "delegate"));
  const after = buildPlan({ capacity: { environments: [env("e-mini", [0, 0])] }, config, environments, ledger: [], listOf: () => { throw new Error("池满不读来源"); } });
  assert.ok(after.selection.assignments.every((a) => a.mode === "skip"));
  assert.ok(first.selection.assignments.every((a) => a.mode === "delegate"), "后续计划不覆盖前段分工事实");
});

test("计划校验", () => {
  const cfg = { repos: [{ repo: MUS }] };
  assert.deepEqual(validatePlan({ launches: [{ repo: MUS, ids: ["a"], environmentId: "e", projectId: "p", title: "t", reason: "r" }] }, cfg), []);
  const errs = validatePlan({ launches: [{ repo: "x/y", ids: [], title: "t" }] }, cfg);
  assert.ok(errs.some((e) => /不在/.test(e)) && errs.some((e) => /ids/.test(e)) && errs.some((e) => /environmentId/.test(e)));
  assert.ok(validatePlan({}, cfg).length);
});

test("本轮模型覆盖：保留完整档位选项与运行模式，不改配置；缺省仍用配置", () => {
  const cfg = { repos: [{ repo: MUS }], runtimeMode: "full-access", model: { instanceId: "pi", model: "cliproxyapi/glm-5.3-flash", options: { thinking: "medium" } } };
  const before = structuredClone(cfg);
  const modelSelection = { instanceId: "acpRegistry_devin", model: "swe-2-high", options: { thought_level: "medium" } };
  const plan = { launches: [{ repo: MUS, ids: ["a"], environmentId: "e", projectId: "p", title: "t", reason: "r" }], modelSelection };
  assert.deepEqual(validatePlan(plan, cfg), []);
  assert.deepEqual(launchConfigFor(plan, cfg).model, modelSelection);
  assert.equal(launchConfigFor(plan, cfg).runtimeMode, "full-access");
  assert.deepEqual(launchConfigFor({ launches: plan.launches }, cfg).model, cfg.model);
  assert.deepEqual(cfg, before);
  for (const bad of [null, [], {}, { ...modelSelection, model: " " }, { ...modelSelection, instanceId: "" }, { ...modelSelection, options: [] }, { ...modelSelection, options: null }, { ...modelSelection, fallback: true }]) {
    assert.ok(validatePlan({ ...plan, modelSelection: bad }, cfg).some((e) => /modelSelection/.test(e)), JSON.stringify(bad));
  }
});

test("用户优先项在截表前提升，暂缓排除，无标签仍参与技术排序", () => {
  const ordinary = Array.from({ length: 10 }, (_, i) => cand(`INT-${i}`, "启动崩溃"));
  const plan = buildPlan({
    capacity: { environments: [env("e-pc", [1, 0])] }, config, environments, ledger: [],
    listOf: () => ({ candidates: [...ordinary,
      cand("INT-90", "架构重构", { labels: ["bstack:priority"] }),
      cand("INT-91", "启动崩溃", { labels: ["bstack:priority", "bstack:defer"] }),
    ], skipped: [] }),
  });
  const r = plan.repos[0];
  assert.equal(r.shortlist[0].ref, "INT-90");
  assert.equal(r.shortlist[0].priority, true);
  assert.equal(r.shortlist.length, 5);
  assert.ok(r.shortlist.slice(1).every((c) => !c.priority));
  assert.ok(r.excluded.some((c) => c.ref === "INT-91"));
});

test("预计名额：实际满但有预计释放时照常列候选与分工，slots 仍按实际空位", () => {
  const pc = env("e-pc", [0, 0]);
  pc.capacity.projectedFreeByRepo = { [MUS]: 1, [TMA]: 0 };
  const plan = buildPlan({ capacity: { generatedAt: "cut", environments: [pc] }, config, environments, ledger: [],
    listOf: () => ({ candidates: [cand("INT-1", "播放失败"), cand("INT-2", "保存失败")], skipped: [] }) });
  const mus = plan.repos.find((r) => r.repo === MUS);
  assert.equal(plan.slots, 0);
  assert.equal(plan.projectedSlots, 1);
  assert.deepEqual(mus.devices.map((d) => [d.alias, d.free, d.projected]), [["pc", 0, 1]]);
  assert.equal(mus.shortlist.length, 2);
  assert.equal(plan.selection.assignments.find((a) => a.repo === MUS).mode, "lead");
  const none = buildPlan({ capacity: { environments: [env("e-pc", [0, 0])] }, config, environments, ledger: [], listOf: () => { throw new Error("没有预计名额不读来源"); } });
  assert.equal(none.projectedSlots, 0);
});

test("子代理输入只含本仓库切片：设备池占用与预计释放、相关台账、命令用法", () => {
  const pc = env("e-pc", [0, 1], { openThreads: [{ title: "GH-360 下载目录", id: "t1" }] });
  Object.assign(pc.capacity, { projectedFreeByRepo: { [MUS]: 1, [TMA]: 1 }, poolByRepo: { [MUS]: "heavy", [TMA]: "general" },
    pools: [{ name: "heavy", occupying: ["#233 设置弹框"], releasing: ["#233 设置弹框"] }, { name: "general", occupying: [], releasing: [] }] });
  const ledger = [{ at: new Date().toISOString(), event: "launched", repo: MUS, id: "a" }, { at: new Date().toISOString(), event: "launched", repo: TMA, id: "b" }];
  const capacity = { generatedAt: "cut", environments: [pc] };
  const plan = buildPlan({ capacity, config, environments, ledger, listOf: () => ({ candidates: [cand("INT-1", "播放失败")], skipped: [] }) });
  const brief = repoBriefOf(plan, MUS, { capacity, ledger, scripts: "/s" });
  assert.equal(brief.capacityAt, "cut");
  assert.deepEqual(brief.devices.map((d) => [d.pool, d.free, d.projected, d.releasing]), [["heavy", 0, 1, ["#233 设置弹框"]]]);
  assert.deepEqual(brief.ledger.active.map((e) => e.id), ["a"]);
  assert.equal(brief.openThreads[0].title, "GH-360 下载目录");
  assert.equal(brief.shortlist[0].ref, "INT-1");
  assert.match(brief.commands.show, /^node \/s\/issue-source\.mjs show --repo .+ --id /);
  assert.equal(briefName(MUS), "fj.frp.musiver.cn_fjbobo_musiver.json");
});

test("建线复核：同设备同池合计不超实际空位，预计名额不能建线", () => {
  const capacity = { environments: [{ environmentId: "e", projects: [{ id: "p-mus", canonicalKey: MUS }, { id: "p-tma", canonicalKey: TMA }],
    capacity: { freeByRepo: { [MUS]: 1, [TMA]: 1 }, projectedFreeByRepo: { [MUS]: 2, [TMA]: 2 }, poolByRepo: { [MUS]: "heavy", [TMA]: "heavy" } } }] };
  const l = (projectId, title) => ({ repo: MUS, ids: ["x"], environmentId: "e", projectId, title, reason: "r" });
  assert.deepEqual(capacityErrors({ launches: [l("p-mus", "A")] }, capacity), []);
  const over = capacityErrors({ launches: [l("p-mus", "A"), l("p-tma", "B")] }, capacity);
  assert.equal(over.length, 1);
  assert.match(over[0], /B.*实际空位 1/);
  assert.match(capacityErrors({ launches: [l("p-x", "C")] }, capacity)[0], /找不到/);
});
