import { test } from "node:test";
import assert from "node:assert/strict";
import { consumed, freshnessOf, launchOf, queuePlan } from "./dispatch-queue.mjs";

const MUS = "host/o/mus";
const TMA = "host/o/tma";
const NOW = Date.parse("2026-11-02T00:00:00Z");
const config = { limits: { perRun: 5, perDay: 0 }, stock: { maxAgeHours: 72 }, repos: [{ repo: MUS }, { repo: TMA }] };
const environments = { pc: { environmentId: "e-pc" }, mini: { environmentId: "e-mini" } };
// MUS 与 TMA 同在 heavy 池时共享空位。
const env = (id, free, poolByRepo = { [MUS]: "heavy", [TMA]: "general" }) => ({
  environmentId: id, alias: id.slice(2),
  projects: [{ id: `${id}-mus`, canonicalKey: MUS }, { id: `${id}-tma`, canonicalKey: TMA }],
  capacity: { freeByRepo: { [MUS]: free[0], [TMA]: free[1] }, poolByRepo },
});
const entry = (id, extra = {}) => ({ id, ref: `INT-${id}`, title: `题 ${id}`, state: "ready", deferredBy: "capacity", scope: "s", reason: "r", nextCheck: "n",
  checkedAt: new Date(NOW - 3600000).toISOString(), issueUpdatedAt: "2026-11-01T00:00:00Z", source: { head: "h", paths: ["p"] }, devices: ["pc"], evidenceRefs: ["e"], ...extra });
const plan = (over) => queuePlan({ capacity: { environments: [env("e-pc", [1, 1])] }, config, environments, pool: { repos: {} }, ledger: [], now: NOW, ...over });

test("按题库顺序出队，各仓库轮流，空位与 perRun 封顶", () => {
  const p = plan({ capacity: { environments: [env("e-pc", [2, 1])] },
    pool: { repos: { [MUS]: [entry("1"), entry("2"), entry("3")], [TMA]: [entry("9")] } } });
  assert.deepEqual(p.picks.map((x) => x.entry.id), ["1", "9", "2"]);
  assert.equal(p.picks[1].projectId, "e-pc-tma");
  const capped = plan({ config: { ...config, limits: { perRun: 1, perDay: 0 } }, pool: { repos: { [MUS]: [entry("1")], [TMA]: [entry("9")] } } });
  assert.equal(capped.picks.length, 1);
});

test("同池仓库共享空位；过期、在派与设备不适配的题目跳过", () => {
  const shared = { [MUS]: "heavy", [TMA]: "heavy" };
  const p = plan({ capacity: { environments: [env("e-pc", [1, 1], shared)] }, pool: { repos: { [MUS]: [entry("1")], [TMA]: [entry("9")] } } });
  assert.equal(p.picks.length, 1);
  const q = plan({
    ledger: [{ at: new Date(NOW).toISOString(), event: "launched", repo: MUS, id: "2" }],
    pool: { repos: { [MUS]: [entry("1", { checkedAt: "2026-10-01T00:00:00Z" }), entry("2"), entry("3", { devices: ["mini"] }), entry("4")] } },
  });
  assert.deepEqual(q.picks.map((x) => x.entry.id), ["4"]);
});

test("待交接优先占同池空位；没有提示词或没空位的交接仍占住该池", () => {
  const h = (id, extra = {}) => ({ sourceThreadId: id, sourceLink: `<${id}>`, targetEnvironmentId: "e-pc", canonicalKey: MUS, waitingSince: "2026-11-01T00:00:00Z", ...extra });
  const p = plan({ handoffs: [h("a", { launch: { projectId: "e-pc-mus", title: "t", message: "m" } })], pool: { repos: { [MUS]: [entry("1")], [TMA]: [entry("9")] } } });
  assert.ok(p.handoffPlan[0].slot);
  assert.deepEqual(p.picks.map((x) => x.entry.id), ["9"], "heavy 被交接占用，general 照派");
  const waiting = plan({ handoffs: [h("b")], capacity: { environments: [env("e-pc", [2, 0])] }, pool: { repos: { [MUS]: [entry("1")] } } });
  assert.match(waiting.handoffPlan[0].blocked, /launch/);
  assert.equal(waiting.picks.length, 0);
  const done = plan({ handoffs: [h("c", { launchedThreadLink: "x" })], pool: { repos: { [MUS]: [entry("1")] } } });
  assert.equal(done.picks.length, 1, "已建线的交接不再占池");
  const auth = plan({ handoffs: [h("d", { needsUser: "生产部署授权", launch: { projectId: "e-pc-mus", title: "t", message: "m" } })], pool: { repos: { [MUS]: [entry("1")] } } });
  assert.ok(!auth.handoffPlan[0].slot, "等用户授权的交接即使有 launch 也不建线");
  assert.match(auth.handoffPlan[0].blocked, /授权/);
  assert.equal(auth.picks.length, 1, "等用户授权的交接不占池");
});

test("出队前复核：不通过的题目不占空位，按 drop 与 recheck 分开", () => {
  const verdict = { "1": { drop: "问题已 closed" }, "2": { recheck: "有更新" } };
  const p = plan({ pool: { repos: { [MUS]: [entry("1"), entry("2"), entry("3")] } }, check: (e) => verdict[e.id] ?? { ok: true } });
  assert.deepEqual(p.picks.map((x) => x.entry.id), ["3"]);
  assert.deepEqual([p.dropped[0].id, p.recheck[0].id], ["1", "2"]);
});

test("freshnessOf：关闭、出 PR、离开准入、暂缓移出；正文更新转重核", () => {
  const e = entry("1");
  const ok = { state: "open", status: "todo", prs: 0, labels: [], updatedAt: e.issueUpdatedAt };
  const cfg = { statuses: ["unset", "todo"] };
  assert.deepEqual(freshnessOf(e, ok, cfg), { ok: true });
  assert.ok(freshnessOf(e, { ...ok, state: "closed" }, cfg).drop);
  assert.ok(freshnessOf(e, { ...ok, prs: 1 }, cfg).drop);
  assert.ok(freshnessOf(e, { ...ok, status: "done" }, cfg).drop);
  assert.ok(freshnessOf(e, { ...ok, labels: ["bstack:defer"] }, cfg).drop);
  assert.ok(freshnessOf(e, { ...ok, updatedAt: "2026-11-01T05:00:00Z" }, cfg).recheck);
  assert.ok(freshnessOf({ ...e, issueUpdatedAt: null }, ok, cfg).recheck);
});

test("派出计划带合并问题与线程标题；已建线、重复或被认领的题目移出题库", () => {
  const l = launchOf({ repo: MUS, entry: entry("1", { mergeIds: ["7"], threadTitle: "INT-1 主题" }), environmentId: "e-pc", projectId: "p" });
  assert.deepEqual([l.ids, l.title], [["1", "7"], "INT-1 主题"]);
  assert.ok(consumed({ threadId: "t", pending: "x" }) && consumed({ duplicate: {} }) && consumed({ error: "主问题认领失败：x" }));
  assert.ok(!consumed({ error: "建线程失败：x" }));
});
