import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { consumed, freshnessOf, idleOf, launchHandoff, launchOf, queuePlan } from "./dispatch-queue.mjs";

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

test("巡检出队固定用 DeepSeek medium，独立出队保留派活配置", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-model-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const model = { instanceId: "pi", model: "test-model" };
  writeFileSync(join(dir, "t3-dispatch.json"), JSON.stringify({ mode: "auto", model, repos: [{ repo: MUS, source: "fast-ship" }] }));
  const capacity = join(dir, "capacity.json");
  writeFileSync(capacity, JSON.stringify({ environments: [] }));
  const run = (...args) => {
    const script = fileURLToPath(new URL("./dispatch-queue.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--capacity", capacity, "--dry-run", ...args], {
      env: { ...process.env, BSTACK_CONFIG_DIR: dir }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).modelSelection;
  };
  assert.deepEqual(run("--patrol"), { instanceId: "pi", model: "cliproxyapi/deepseek-v4.1-flash", options: { thinking: "medium" } });
  assert.equal(run("--user").model, model.model);
});

test("按题库顺序出队，各仓库轮流，空位与 perRun 封顶", () => {
  const p = plan({ capacity: { environments: [env("e-pc", [2, 1])] },
    pool: { repos: { [MUS]: [entry("1"), entry("2"), entry("3")], [TMA]: [entry("9")] } } });
  assert.deepEqual(p.picks.map((x) => x.entry.id), ["1", "9", "2"]);
  assert.equal(p.picks[1].projectId, "e-pc-tma");
  const capped = plan({ config: { ...config, limits: { perRun: 1, perDay: 0 } }, pool: { repos: { [MUS]: [entry("1")], [TMA]: [entry("9")] } } });
  assert.equal(capped.picks.length, 1);
});

test("余位区分无启用仓库、不适配、预算和交接占池，预算外不查来源", () => {
  const capacity = { environments: [env("e-pc", [2, 2])] };
  const cfg = { ...config, repos: [{ repo: MUS }, { repo: TMA, devices: ["mini"] }], limits: { perRun: 1, perDay: 0 } };
  const pool = { repos: { [MUS]: [entry("1"), entry("2")] } };
  const checked = [];
  const reasons = (p) => Object.fromEntries(idleOf(p).map((s) => [s.pool, s.reason]));
  assert.deepEqual(reasons(plan({ capacity, config: cfg, pool, check: (e) => (checked.push(e.id), { ok: true }) })),
    { heavy: "派活预算用尽，仍有待复核题目", general: "无启用的派活仓库" });
  assert.deepEqual(checked, ["1"]);
  assert.equal(reasons(plan({ capacity, config: cfg, pool: { repos: { [MUS]: [entry("3", { devices: ["mini"] })] } } })).heavy, "题库无适配题目");
  assert.equal(reasons(plan({ capacity, config: cfg, pool, handoffs: [{ canonicalKey: MUS, targetEnvironmentId: "e-pc" }] })).heavy, "交接占池");
});

test("待交接建线默认补编排入口，保留已有首行命令和接力原文", async () => {
  const android = "## 后续段（必交）：Android 迁移到能力位入口\n\n迁移 Kotlin 调用并补 FFI 回归。\n\n> 交接自 <t3-thread://v2/mbp/swift>";
  const swift = "在 MBP 实施 Swift 确认框。\n\n> 交接自 <t3-thread://v2/pc/desktop>\n> 后续：合并后交接给 Windows 设备";
  const verify = "只补端到端证据截图，不改代码。";
  const other = "/skill:pr-finish\r\n" + swift.replaceAll("\n", "\r\n");
  const reminder = "请先加载并按 `t3-orchestrator` 技能执行；小任务直接做。";
  const withReminder = "/skill:pr-finish\r\n\r\n" + reminder + "\r\n\r\n" + swift.replaceAll("\n", "\r\n");
  const model = { instanceId: "pi", model: "example" };
  for (const [message, verificationOnly, expected] of [
    [android, undefined, `/t3-orchestrator\n\n${android}`],
    [swift, undefined, `/t3-orchestrator\n\n${swift}`],
    [`/t3-orchestrator\n${swift}`, undefined, `/t3-orchestrator\n${swift}`],
    [`/skill:t3-orchestrator\n${swift}`, undefined, `/skill:t3-orchestrator\n${swift}`],
    [verify, true, verify],
    [other, undefined, withReminder],
    [withReminder, undefined, withReminder],
  ]) {
    const launch = { projectId: "e-mini-mus", title: "交接", message, ...(verificationOnly ? { verificationOnly } : {}) };
    const result = await launchHandoff({ canonicalKey: MUS, sourceThreadId: "old", targetEnvironmentId: "e-mini", launch }, model, config, async (tool, input) => {
      assert.equal(tool, "t3_thread_launch");
      assert.equal(input.message, expected);
      assert.equal(input.clientRequestId, "t3-patrol-handoff-old");
      assert.equal(input.projectId, launch.projectId);
      assert.equal(input.modelSelection, model);
      assert.equal(Object.hasOwn(input, "verificationOnly"), false);
      return { threadId: "new", link: "<new>" };
    });
    assert.deepEqual(result, { threadId: "new", link: "<new>" });
    assert.equal(launch.message, message, "不改写队列原文");
  }
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
