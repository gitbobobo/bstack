import { test } from "node:test";
import assert from "node:assert/strict";
import { briefName, buildPlan, rankOf, repoBriefOf } from "./dispatch-plan.mjs";
import { refillStatus, validateCandidate } from "./candidate-pool.mjs";
import { capacityErrors, validatePlan, launchConfigFor } from "./dispatch-launch.mjs";

const MUS = "fj.frp.musiver.cn/fjbobo/musiver";
const TMA = "fj.frp.musiver.cn/fjbobo/tma";
const config = {
  limits: { perRun: 5, perDay: 20, maxAttempts: 2 },
  stock: { multiplier: 3, maxAgeHours: 72 },
  repos: [{ repo: MUS }, { repo: TMA, devices: ["mini"] }],
};
const environments = { pc: { environmentId: "e-pc" }, mini: { environmentId: "e-mini" } };
// max 是所属池名额：MUS 在 heavy，TMA 在 general。
const env = (id, max = [1, 1], extra = {}) => ({
  environmentId: id,
  label: id,
  projects: [{ id: `${id}-mus`, canonicalKey: MUS }, { id: `${id}-tma`, canonicalKey: TMA }],
  capacity: { freeByRepo: { [MUS]: max[0], [TMA]: max[1] }, poolByRepo: { [MUS]: "heavy", [TMA]: "general" }, pools: [{ name: "heavy", max: max[0] }, { name: "general", max: max[1] }] },
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

test("库存目标 = 倍数 × 可派设备所属池名额；devices 限定设备，不可达设备单列", () => {
  const status = refillStatus({ repos: config.repos, pool: { repos: { [MUS]: [saved(cand("INT-1", "x"))] } },
    envs: [env("e-pc", [3, 2]), env("e-mini", [2, 2]), { environmentId: "e-x", error: "离线", projects: [{ id: "p", canonicalKey: MUS }] }], environments, now: NOW });
  const mus = status.find((s) => s.repo === MUS);
  assert.deepEqual([mus.capacity, mus.target, mus.stock, mus.deficit, mus.pool], [5, 15, 1, 14, "heavy"]);
  assert.deepEqual(mus.unknownDevices, ["e-x"]);
  const tma = status.find((s) => s.repo === TMA);
  assert.deepEqual([tma.devices, tma.target], [["mini"], 6]);
  const stale = refillStatus({ repos: [{ repo: MUS }], pool: { repos: { [MUS]: [saved(cand("INT-1", "x"), { checkedAt: "2026-10-01T00:00:00Z" })] } }, envs: [env("e-pc")], environments, now: NOW });
  assert.equal(stale[0].stock, 0, "过期 ready 不计库存");
});

test("库存够就不列候选；缺口仓库只列不在库存里的题目，表长按缺口", () => {
  let listed = [];
  const full = { [MUS]: [1, 2, 3].map((i) => saved(cand(`INT-${i}`, "x"))), [TMA]: [4, 5, 6].map((i) => saved(cand(`INT-${i}`, "x"), { devices: ["mini"] })) };
  const none = buildPlan({ capacity: { environments: [env("e-pc"), env("e-mini")] }, config: { ...config, stock: { multiplier: 1 } }, environments, ledger: [], candidatePool: full, now: NOW,
    listOf: (repo) => (listed.push(repo), { candidates: [], skipped: [] }) });
  assert.deepEqual(none.repos, []);
  assert.deepEqual(listed, []);

  const many = Array.from({ length: 12 }, (_, i) => cand(`INT-${100 + i}`, `第 ${i} 个功能错误`));
  const plan = buildPlan({
    capacity: { environments: [env("e-pc", [1, 0], { openThreads: [{ title: "INT-100 正在做", link: "<l>" }] })] },
    config, environments, now: NOW,
    candidatePool: { [MUS]: [saved(cand("INT-1", "旧题"))] },
    ledger: [{ at: new Date(NOW).toISOString(), event: "launched", repo: MUS, id: "id-INT-101" }],
    listOf: () => ({ candidates: [cand("INT-1", "旧题"), cand("INT-99", "启动崩溃"), ...many], skipped: [{ ref: "x" }] }),
  });
  assert.deepEqual(plan.repos.map((r) => r.repo), [MUS], "TMA 只允许 mini，mini 不在快照里，目标为 0");
  const mus = plan.repos[0];
  assert.equal(mus.deficit, 2);
  assert.ok(!mus.shortlist.some((c) => c.ref === "INT-1"), "库存里的题不重复研判");
  assert.deepEqual(mus.excluded.map((e) => e.ref), ["INT-101"]);
  assert.equal(mus.shortlist.find((c) => c.ref === "INT-100").threadMatch.link, "<l>");
  assert.equal(mus.shortlist[0].ref, "INT-99", "崩溃排第一");
  assert.equal(mus.shortlist.length, 5);
  assert.equal(mus.more, 7);
  assert.equal(mus.sourceSkipped, 1);
});

test("过期、阻塞或待核的旧条目带 pooled 回到研判；池里有、列表没了的进 poolMissing", () => {
  const old = cand("INT-1", "播放失败");
  const gone = cand("INT-9", "已关闭");
  const p = buildPlan({ capacity: { environments: [env("e-pc")] }, config, environments, ledger: [], now: NOW,
    candidatePool: { [MUS]: [saved(old, { state: "pending", deferredBy: "evidence" }), saved(gone)] },
    listOf: () => ({ candidates: [old], skipped: [] }) });
  assert.equal(p.repos[0].shortlist[0].pooled.state, "pending");
  assert.deepEqual(p.repos[0].poolMissing, [{ id: gone.id, ref: "INT-9" }]);
});

test("用户优先项在截表前提升，暂缓排除", () => {
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
  assert.ok(r.shortlist.slice(1).every((c) => !c.priority));
  assert.ok(r.excluded.some((c) => c.ref === "INT-91"));
});

test("补货切片只含本仓库：缺口、设备、相关台账与写池命令", () => {
  const ledger = [{ at: new Date().toISOString(), event: "launched", repo: MUS, id: "a" }, { at: new Date().toISOString(), event: "launched", repo: TMA, id: "b" }];
  const capacity = { environments: [env("e-pc", [1, 1], { openThreads: [{ title: "GH-360 下载目录", id: "t1" }] })] };
  const plan = buildPlan({ capacity, config, environments, ledger, listOf: () => ({ candidates: [cand("INT-1", "播放失败")], skipped: [] }) });
  const brief = repoBriefOf(plan, MUS, { capacity, ledger, scripts: "/s" });
  assert.deepEqual([brief.need, brief.target, brief.stock, brief.devices], [3, 3, 0, ["pc"]]);
  assert.deepEqual(brief.ledger.active.map((e) => e.id), ["a"]);
  assert.equal(brief.openThreads[0].title, "GH-360 下载目录");
  assert.match(brief.commands.apply, /candidate-pool\.mjs apply --repo /);
  assert.match(brief.commands.show, /^node [\/\\]s[\/\\]issue-source\.mjs show --repo .+ --id /);
  assert.equal(briefName(MUS), "fj.frp.musiver.cn_fjbobo_musiver.json");
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

test("建线复核：同设备同池合计不超实际空位", () => {
  const capacity = { environments: [{ environmentId: "e", projects: [{ id: "p-mus", canonicalKey: MUS }, { id: "p-tma", canonicalKey: TMA }],
    capacity: { freeByRepo: { [MUS]: 1, [TMA]: 1 }, poolByRepo: { [MUS]: "heavy", [TMA]: "heavy" } } }] };
  const l = (projectId, title) => ({ repo: MUS, ids: ["x"], environmentId: "e", projectId, title, reason: "r" });
  assert.deepEqual(capacityErrors({ launches: [l("p-mus", "A")] }, capacity), []);
  const over = capacityErrors({ launches: [l("p-mus", "A"), l("p-tma", "B")] }, capacity);
  assert.equal(over.length, 1);
  assert.match(over[0], /B.*实际空位 1/);
  assert.match(capacityErrors({ launches: [l("p-x", "C")] }, capacity)[0], /找不到/);
});
