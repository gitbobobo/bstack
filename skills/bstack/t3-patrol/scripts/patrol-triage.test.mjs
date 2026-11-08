import { test } from "node:test";
import assert from "node:assert/strict";
import { fullRoundOf, triageOf } from "./patrol-triage.mjs";
import { probeFor } from "./patrol-state.mjs";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const thresholds = { queuedMinutes: 30, silenceMinutes: 60, minDistinctCommands: 5, reviewWaitMinutes: 30, idleQuestionMinutes: 30 };
const since = ago(60);
const tri = (c, s = since) => triageOf(c, { since: s, thresholds, now: NOW });

test("全量轮：没有上一轮、上一轮太久、或距上次全量已满", () => {
  const cfg = { fullEveryHours: 6 };
  assert.equal(fullRoundOf(null, cfg, NOW).full, true);
  assert.equal(fullRoundOf({ snapshotAt: ago(240), lastFullAt: ago(240) }, cfg, NOW).full, true);
  assert.equal(fullRoundOf({ snapshotAt: ago(60), lastFullAt: ago(400) }, cfg, NOW).full, true);
  assert.equal(fullRoundOf({ snapshotAt: ago(60), lastFullAt: null }, cfg, NOW).full, true);
  assert.deepEqual(fullRoundOf({ snapshotAt: ago(60), lastFullAt: ago(120) }, cfg, NOW), { full: false, since: ago(60) });
});

test("全量时一律有事", () => {
  assert.equal(tri({ status: "running", distinctRecentCommands: 10, recentToolCalls: 30 }, null).triage, "hot");
});

test("在跑且信号正常为静默；空转或沉默为有事", () => {
  assert.equal(tri({ status: "running", recentToolCalls: 30, distinctRecentCommands: 12, minutesSinceLastMessage: 10 }).triage, "quiet");
  assert.deepEqual(tri({ status: "running", recentToolCalls: 30, distinctRecentCommands: 2, minutesSinceLastMessage: 10 }).triageReasons, ["疑似空转"]);
  assert.deepEqual(tri({ status: "running", recentToolCalls: 30, distinctRecentCommands: 12, minutesSinceLastMessage: 90 }).triageReasons, ["消息沉默"]);
});

test("停住的线程：上轮后无变化为静默，有新活动为有事", () => {
  assert.equal(tri({ status: "completed", lastMsgAt: ago(120), lastRunEndedAt: ago(120) }).triage, "quiet");
  assert.deepEqual(tri({ status: "completed", lastMsgAt: ago(20), lastRunEndedAt: ago(20) }).triageReasons, ["上轮后有新活动"]);
});

test("PR 有新事件、检查久未出结论在两轮之间超时才算有事", () => {
  const base = { status: "completed", lastMsgAt: ago(200), lastRunEndedAt: ago(200) };
  assert.deepEqual(tri({ ...base, prHealth: [{ pr: "#1", latestAt: ago(10), headAt: ago(300) }] }).triageReasons, ["#1 有新事件"]);
  // 审查中 45 分钟：截止时间（15 分钟前）落在两轮之间。
  assert.deepEqual(tri({ ...base, prHealth: [{ pr: "#1", headAt: ago(300), checks: [{ name: "代码审查", state: "pending", at: ago(45) }] }] }).triageReasons, ["#1 代码审查 久未出结论"]);
  // 上一轮已经超时：本轮不再因此变成有事。
  assert.equal(tri({ ...base, prHealth: [{ pr: "#1", headAt: ago(300), checks: [{ name: "代码审查", state: "pending", at: ago(200) }] }] }).triage, "quiet");
  assert.deepEqual(tri({ ...base, prHealth: [{ pr: "#1", headAt: ago(45), checks: [] }] }).triageReasons, ["#1 有新事件", "#1 HEAD 无审查与检查"]);
});

test("失败、待答请求、取证失败、久审、未消费结论都算有事", () => {
  assert.ok(tri({ status: "failed" }).triageReasons.includes("失败"));
  assert.ok(tri({ status: "completed", pendingRequestCount: 1 }).triageReasons.includes("待答请求"));
  assert.ok(tri({ status: "completed", incomplete: true }).triageReasons.includes("取证失败"));
  // 久审本身不叫醒；有别的变化时一并标出。
  assert.equal(tri({ status: "running", needsConvergenceAudit: true, recentToolCalls: 30, distinctRecentCommands: 12 }).triage, "quiet");
  assert.deepEqual(tri({ status: "completed", needsConvergenceAudit: true, lastMsgAt: ago(10) }).triageReasons, ["上轮后有新活动", "久审"]);
  assert.ok(tri({ status: "completed", prs: ["o/r#1:open(stale)"] }).triageReasons.includes("结论未消费"));
});

test("排队超时", () => {
  assert.deepEqual(tri({ status: "queued", lastRunEndedAt: ago(45) }).triageReasons, ["排队超时"]);
  assert.equal(tri({ status: "queued", lastRunEndedAt: ago(5) }).triage, "quiet");
});

test("探测缓存按 TTL 生效", () => {
  const state = { probes: { e1: { diskFreeGB: 100, at: ago(60) }, e2: { diskFreeGB: 50, at: ago(300) } } };
  assert.equal(probeFor(state, "e1", 3, NOW).diskFreeGB, 100);
  assert.equal(probeFor(state, "e2", 3, NOW), null);
  assert.equal(probeFor(state, "e3", 3, NOW), null);
});
