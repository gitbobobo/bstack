import { test } from "node:test";
import assert from "node:assert/strict";
import { runCalls } from "./patrol-batch.mjs";
import { judgeBatches, judgeInput, mergeDecisions, packOf, reportOf, reviewLine, settleGuard, tierOf, tierReasonOf } from "./patrol-round.mjs";

const ladder = [{ name: "glm" }, { name: "swe" }, { name: "ds", fallback: true }];
const cand = (id, triage, extra = {}) => ({ id, link: `<${id}>`, title: `T${id}`, triage, triageReasons: [], ...extra });
const snap = (extra = {}) => ({
  generatedAt: "2026-11-02T00:00:00Z", modelLadder: ladder, lastRound: null, triage: { full: false, since: "x" },
  config: { warnings: [], errors: [], thresholds: { silenceMinutes: 60 } },
  environmentsFile: { warnings: [], errors: [], unlisted: [], missing: [] },
  pendingHandoffs: [],
  environments: [{
    environmentId: "e1", alias: "pc",
    candidates: [cand("1", "hot"), cand("2", "quiet"), cand("3", "quiet"), cand("4", "hot"), cand("5", "hot")],
    needsRenameThreads: [{ id: "3", reasons: ["raw"] }],
    failedThreads: [{ id: "9", link: "<9>", status: "failed", source: "filtered", runs: [{ error: "boom" }] }],
    checks: { hot: 3, quiet: 2, failedThreads: 1, needsWatchThreads: 0, needsRenameThreads: 1, convergenceAuditThreads: 0, patrolExcluded: 0 },
    capacity: { pools: [{ name: "heavy", used: 1, max: 3 }, { name: "general", used: 2, max: 2 }] },
  }],
  ...extra,
});

test("档位：无额度失败用首选档；上一轮失败先探测；本轮失败交 recovery 判", () => {
  assert.deepEqual([tierOf(snap()).suggest, tierOf(snap()).probe], ["glm", undefined]);
  assert.equal(tierOf(snap({ lastRound: { quotaFailure: true } })).probe, true);
  const s = snap();
  s.environments[0].failedThreads[0].runs[0].error = "model_usage_exhausted";
  assert.equal(tierOf(s).suggest, null);
  assert.deepEqual(tierOf(s).quotaThreads, ["<9>"]);
});

test("研判分批：有事、静默线程的命名、过滤外失败、孤立待交接都进批次，按环境与批量切分", () => {
  const s = snap({ pendingHandoffs: [
    { sourceEnvironmentId: "e1", sourceThreadId: "1", sourceLink: "<1>", task: "x" },
    { sourceEnvironmentId: "e1", sourceThreadId: "gone", sourceLink: "<gone>", task: "孤立交接" },
  ] });
  const batches = judgeBatches(s, { size: 4 });
  const items = batches.flatMap((b) => b.items);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ["hot:1", "rename:3", "hot:4", "hot:5", "failed:9", "handoff:gone"]);
  assert.deepEqual(batches.map((b) => b.items.length), [4, 2]);
  assert.equal(items[0].pendingHandoff.sourceThreadId, "1");
  assert.deepEqual(items[1].reasons, ["raw"]);
  const input = judgeInput(s, batches[0], { out: "/o.json" });
  assert.match(input.commands.evidence, /patrol-evidence\.mjs --thread <threadId>@e1/);
  assert.equal(input.thresholds.silenceMinutes, 60);
});

test("决策包只给计数、批次与派活状态，不含候选详情", () => {
  const s = snap();
  s.environmentsFile.unlisted = ["e9"];
  const pack = packOf(s, { dir: "/d", batches: judgeBatches(s), watch: [{ result: {} }, { skipped: "x" }, { url: "u", error: "e" }], dispatch: { enabled: false, reason: "mode 为 off" } });
  assert.equal(pack.environments[0].capacity, "heavy 1/3，general 2/2");
  assert.equal(pack.environments[0].hot, 3);
  assert.deepEqual(pack.watch, { added: 1, skipped: 1, failed: ["u：e"] });
  assert.equal(pack.judge[0].file, "/d/judge-1.json");
  assert.equal(pack.maxConcurrent, 3, "未配置时同时最多 3 个子代理");
  assert.ok(pack.warnings.some((w) => /设备对照/.test(w)));
  assert.ok(!JSON.stringify(pack).includes("triageReasons"));
});

test("合并研判结果：同线程后者覆盖，缺 threadId 或未知动作报错", () => {
  const d = (threadId, action = "none", summary = "") => ({ environmentId: "e1", threadId, kind: "k", action, summary });
  assert.deepEqual(mergeDecisions([[d("1"), d("2")], [d("1", "send", "后者")]]).map((x) => x.summary), ["后者", ""]);
  assert.throws(() => mergeDecisions([[{ action: "none" }]]), /threadId/);
  assert.throws(() => mergeDecisions([[d("1", "fly")]]), /action/);
});

test("报告骨架：按环境列研判与回读、静默合一行、派活结果、需要你决定与阻塞", () => {
  const decisions = [
    { environmentId: "e1", threadId: "1", link: "<1>", title: "T1", kind: "finish", action: "send", summary: "已收敛，推收尾", results: [{ ok: true, verified: "running" }] },
    { environmentId: "e1", threadId: "4", link: "<4>", title: "T4", kind: "decision", action: "report", summary: "等产品取舍", needsUser: "选 A 或 B" },
    { environmentId: "e1", threadId: "5", link: "<5>", title: "T5", kind: "stall", action: "send", summary: "推进", results: [{ ok: false, error: "quota" }] },
  ];
  const md = reportOf(snap(), decisions, { tier: "glm", dispatch: { launched: [{ ref: "INT-1", device: "pc", link: "<n>" }], idle: [{ device: "pc", pool: "heavy", free: 1 }] } });
  assert.match(md, /- <1> T1：已收敛，推收尾｜running/);
  assert.match(md, /静默 2 个：T2、T3/);
  assert.match(md, /INT-1 → pc：<n>/);
  assert.match(md, /空位 pc\/heavy 余 1/);
  assert.match(md, /### 需要你决定\n- <4>：选 A 或 B/);
  assert.match(md, /### 阻塞\n- <5>：quota/);
  assert.match(md, /档位：glm（上一轮与本轮均无额度失败）/, "档位依据不留占位");
});

test("#417：待发消息展示收结措辞；提示词已交付但下一段未接手时拦截 settle", () => {
  const handoff = { sourceEnvironmentId: "mbp", sourceThreadId: "417", task: "段 2：watchOS FFmpeg" };
  const d = { environmentId: "mbp", threadId: "417", handoff };
  const settle = { tool: "t3_thread_organize", args: { ...d, action: "settle" } };
  const message = `【巡检】${"核对回收。".repeat(20)}\n回报结果并收结。`;
  assert.ok(reviewLine({ ...d, calls: [{ tool: "t3_thread_send", args: { message } }] }).includes(message));
  assert.match(settleGuard(d, settle, []), /入账/);
  delete d.handoff;
  assert.match(settleGuard(d, settle, [handoff]), /缺结案依据/);
  d.closeout = { outcome: "no-followup", evidenceRef: "PR 已合并，目录只剩壳", deviceRef: "来源设备 open=[]" };
  assert.match(settleGuard(d, settle, [handoff]), /仍有待交接/);
  d.closeout = { outcome: "accepted", evidenceRef: "段 2 目标线程的 FFmpeg 验证活动 #15", deviceRef: "来源设备 open=[]" };
  assert.match(settleGuard(d, settle, [handoff]), /仍有待交接/);
  d.handoffResolve = { ...handoff, outcome: "accepted", evidenceRef: d.closeout.evidenceRef };
  assert.equal(settleGuard(d, settle, [handoff]), null);
  assert.match(settleGuard(d, { ...settle, args: { ...settle.args, threadId: "other" } }, [handoff]), /对应 settle 目标/);
  delete d.closeout.deviceRef;
  assert.match(settleGuard(d, settle, [handoff]), /设备锁证据/);
});

test("旧版批处理入口不能绕过结案校验", async () => {
  const [result] = await runCalls([{ tool: "t3_thread_organize", args: { threadId: "417", action: "settle" } }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /结案校验/);
});

test("档位依据：本轮额度失败优先，其次开局建议与实际档位的差异", () => {
  assert.match(tierReasonOf(snap(), "glm", true), /换档重派，首选档保持/);
  assert.match(tierReasonOf(snap(), "swe", true), /改用 swe/);
  assert.match(tierReasonOf(snap(), "swe", false), /无额度失败；按 recovery.md 改用 swe/);
});
