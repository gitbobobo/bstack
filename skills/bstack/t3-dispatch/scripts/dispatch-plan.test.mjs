import { test } from "node:test";
import assert from "node:assert/strict";
import { briefName, buildPlan, rankOf, repoBriefOf, skipReasonOf } from "./dispatch-plan.mjs";
import { refillStatus, validateCandidate } from "./candidate-pool.mjs";
import { capacityErrors, validatePlan, launchConfigFor } from "./dispatch-launch.mjs";

const MUS = "fj.frp.musiver.cn/fjbobo/musiver";
const TMA = "fj.frp.musiver.cn/fjbobo/tma";
const config = {
  limits: { perRun: 5, perDay: 20, maxAttempts: 2 },
  stock: { multiplier: 3, maxAgeHours: 72, recheckHours: 24 },
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
  const full = { [MUS]: [1, 2, 3].map((i) => saved(cand(`INT-${i}`, "x"), { devices: ["pc", "mini"] })), [TMA]: [4, 5, 6].map((i) => saved(cand(`INT-${i}`, "x"), { devices: ["mini"] })) };
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

test("仓库总库存达标仍补空位设备；在派题不算库存，近期排除依据不重复核", () => {
  const a = cand("INT-1", "共享层回归");
  const b = cand("INT-2", "专属宿主回归");
  const active = cand("INT-3", "Windows 回归");
  const capacity = { environments: [env("e-pc"), env("e-mini")] };
  const inputs = { capacity, config: { ...config, repos: [{ repo: MUS }, { repo: TMA, devices: ["mini"] }], stock: { multiplier: 1 } }, environments, now: NOW,
    candidatePool: { [MUS]: [saved(a, { devices: ["mini"] }), saved(b, { devices: ["mini"], deviceExclusions: { pc: "Windows 无宿主验证入口" } }), saved(active)],
      [TMA]: [saved(cand("INT-4", "x"), { devices: ["mini"] })] },
    ledger: [{ at: new Date(NOW).toISOString(), event: "launched", repo: MUS, id: active.id, environmentId: "e-pc", threadId: "running" }] };
  capacity.environments[0].openThreads.push({ id: "running" });
  const plan = buildPlan({ ...inputs, listOf: () => ({ candidates: [a, b, active], skipped: [] }) });
  const brief = repoBriefOf(plan, MUS, { capacity });
  assert.equal(brief.need, 0);
  assert.deepEqual(plan.repos.map((r) => r.repo), [MUS]);
  assert.deepEqual(brief.deviceGaps, [{ device: "pc", pool: "heavy", free: 1, stock: 0, need: 1 }]);
  assert.deepEqual(brief.deviceReviews.map((x) => [x.ref, x.devices]), [[a.ref, ["pc"]]]);
  assert.equal(skipReasonOf(plan.repos[0]), null, "没有新题也派设备重核");
  const updated = buildPlan({ ...inputs, listOf: () => ({ candidates: [a, { ...b, updatedAt: "2026-11-01T01:00:00Z" }, active], skipped: [] }) });
  assert.deepEqual(updated.repos[0].deviceReviews.map((x) => x.ref), [a.ref, b.ref]);
  assert.throws(() => saved(a, { deviceExclusions: { pc: "冲突" } }), /deviceExclusions/);
});

test("跨设备备货时一题只覆盖首个有空位的设备", () => {
  const capacity = { environments: [env("e-pc"), env("e-mini")] };
  const shared = cand("INT-1", "共享层");
  const miniOnly = cand("INT-2", "Mac 宿主");
  const plan = buildPlan({ capacity, config: { ...config, repos: [{ repo: MUS }], stock: { multiplier: 1, maxAgeHours: 48 } }, environments, ledger: [], now: NOW,
    candidatePool: { [MUS]: [saved(shared, { devices: ["mini", "pc"] }), saved(miniOnly, { devices: ["mini"] })] },
    listOf: () => ({ candidates: [shared, miniOnly], skipped: [] }) });
  const brief = repoBriefOf(plan, MUS, { capacity });
  assert.equal(brief.need, 0);
  assert.equal(brief.maxAgeHours, 48);
  assert.deepEqual(brief.deviceGaps, [{ device: "pc", pool: "heavy", free: 1, stock: 0, need: 1 }]);
});

test("阻塞或待核的旧条目过期或来源更新才带 pooled 回到研判；池里有、列表没了的进 poolMissing", () => {
  const old = cand("INT-1", "播放失败");
  const updated = cand("INT-2", "保存失败", { updatedAt: "2026-11-01T12:00:00Z" });
  const stale = cand("INT-3", "下载失败");
  const parked = cand("INT-4", "同步失败");
  const gone = cand("INT-9", "已关闭");
  const pending = { state: "pending", deferredBy: "evidence" };
  const p = buildPlan({ capacity: { environments: [env("e-pc")] }, config, environments, ledger: [], now: NOW,
    candidatePool: { [MUS]: [
      saved(old, { ...pending, issueUpdatedAt: null }),
      saved(updated, { ...pending, issueUpdatedAt: "2026-11-01" }),
      saved(stale, { state: "blocked", deferredBy: "dependency", checkedAt: "2026-10-31T23:00:00Z" }),
      saved(parked, { state: "blocked", deferredBy: "dependency" }),
      saved(gone),
    ] },
    listOf: () => ({ candidates: [old, updated, stale, parked], skipped: [] }) });
  const r = p.repos[0];
  assert.deepEqual(r.shortlist.map((c) => c.ref).sort(), ["INT-1", "INT-2", "INT-3"], "来源时间未知、来源更新、超过 recheckHours 都重核");
  assert.ok(r.shortlist.every((c) => c.pooled));
  assert.deepEqual(r.parked.map((c) => [c.ref, c.state]), [["INT-4", "blocked"]]);
  assert.deepEqual(r.poolMissing, [{ id: gone.id, ref: "INT-9" }]);
});

test("没有待办的缺货仓库给出 skip，不派补货子代理；台账线程已结束或认领未记线程则要对账", () => {
  const parked = cand("INT-4", "同步失败");
  const deferred = cand("INT-5", "体验", { labels: ["bstack:defer"] });
  const plan = (ledger, openThreads = []) => buildPlan({ capacity: { environments: [env("e-pc", [1, 1], { openThreads })] }, config: { ...config, repos: [{ repo: MUS }] }, environments, ledger, now: NOW,
    candidatePool: { [MUS]: [saved(parked, { state: "blocked", deferredBy: "dependency" })] },
    listOf: () => ({ candidates: [parked, deferred], skipped: [{ ref: "x" }] }) }).repos[0];
  const at = new Date(NOW).toISOString();
  const idle = plan([]);
  assert.equal(skipReasonOf(idle), "无待研判内容：题库阻塞/待核且来源未更新 1，暂缓 1，来源跳过 1");
  const empty = buildPlan({ capacity: { environments: [env("e-pc")] }, config: { ...config, repos: [{ repo: MUS }] }, environments, ledger: [], now: NOW, listOf: () => ({ candidates: [], skipped: [] }) }).repos[0];
  assert.equal(skipReasonOf(empty), "无待研判内容：来源无可派问题");

  const launched = { at, event: "launched", repo: MUS, id: "id-INT-7", environmentId: "e-pc", threadId: "t7" };
  assert.deepEqual(plan([launched], [{ id: "t7", title: "INT-7" }]).ledgerStale, [], "线程还开着不必对账");
  const closed = plan([launched]);
  assert.deepEqual(closed.ledgerStale, [{ id: "id-INT-7", event: "launched" }]);
  assert.equal(skipReasonOf(closed), null);
  assert.deepEqual(plan([{ ...launched, environmentId: "e-gone" }]).ledgerStale, [], "环境不在快照里无法判定");
  assert.equal(skipReasonOf(plan([{ at, event: "claimed", repo: MUS, id: "id-INT-8", ref: "INT-8" }])), null);

  idle.excluded.push({ ref: "INT-6", reason: "回读确认未结线程", duplicateReview: true });
  assert.equal(skipReasonOf(idle), null, "线程命中要子代理复核范围");
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
