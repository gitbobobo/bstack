import { test } from "node:test";
import assert from "node:assert/strict";
import { bgKillsOf, fullRoundOf, triageOf } from "./patrol-triage.mjs";

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

test("跨设备待交接：来源无新活动、来源设备未释放也每轮复核，销账后才可静默", () => {
  const source = { status: "completed", lastMsgAt: ago(240), lastRunEndedAt: ago(240), prs: ["o/r#46:merged"], pendingHandoff: { targetEnvironmentId: "mini", blocker: "池 4/4" } };
  assert.deepEqual(tri(source).triageReasons, ["待交接未销账"]);
  // 目标 Mini 释放名额不会改变来源 MBP 的 deviceFreed，仍须被唤起。
  assert.equal(triageOf(source, { since: ago(20), thresholds, now: NOW, deviceFreed: false }).triage, "hot");
  assert.equal(tri({ ...source, pendingHandoff: undefined }).triage, "quiet");
});

test("排队超时", () => {
  assert.deepEqual(tri({ status: "queued", lastRunEndedAt: ago(45) }).triageReasons, ["排队超时"]);
  assert.equal(tri({ status: "queued", lastRunEndedAt: ago(5) }).triage, "quiet");
});

test("等待资源：无变化时静默；设备空出名额或等待在两轮之间满时限才叫醒", () => {
  const base = { status: "completed", lastMsgAt: ago(200), lastRunEndedAt: ago(200), waitingResources: { at: ago(100) } };
  assert.deepEqual(tri(base).triageReasons, ["等待资源"]);
  assert.equal(tri(base).triage, "quiet");
  assert.deepEqual(triageOf(base, { since, thresholds, now: NOW, deviceFreed: true }).triageReasons, ["设备空出名额，资源可能已释放"]);
  const long = { ...base, waitingResources: { at: ago(200) } };
  assert.deepEqual(triageOf(long, { since, thresholds, now: NOW, resourceWakeHours: 3 }).triageReasons, ["等待资源已满 3 小时"]);
  assert.equal(triageOf({ ...base, waitingResources: { at: ago(400) } }, { since, thresholds, now: NOW, resourceWakeHours: 3 }).triage, "quiet");
});

test("后台进程随超时被杀：单独的 & 加超时输出才算", () => {
  const cmd = (text, at = ago(10)) => ({ type: "command_execution", text, updatedAt: at });
  const items = [
    cmd("$ cd /w && nohup pnpm pr-check > /tmp/a.log 2>&1 & echo \"pid $!\"\nCommand timed out", ago(30)),
    cmd("$ cd /w && pnpm test > /tmp/b.log 2>&1; echo exit=$?\nCommand timed out"),
    cmd("$ pnpm build &> /tmp/c.log\nCommand timed out after 30 seconds"),
    cmd("$ nohup sleep 9 > /tmp/d.log 2>&1 &\nExited with code 0"),
    { type: "dynamic_tool", text: "x & y\nCommand timed out" },
    cmd("$ cd /w && nohup pnpm pr-check > /tmp/e.log 2>&1 & echo started; sleep 240\nCommand timed out after 280000ms", ago(5)),
  ];
  const k = bgKillsOf(items);
  assert.equal(k.count, 2);
  assert.equal(k.lastAt, ago(5));
  assert.match(k.sample, /prcheck|pr-check/);
  assert.equal(bgKillsOf(items.slice(1, 5)), null);
});

test("后台进程随超时被杀：上一轮以来出现过就叫醒，在跑与停着都算", () => {
  const stopped = { status: "completed", lastMsgAt: ago(200), lastRunEndedAt: ago(200) };
  assert.deepEqual(tri({ ...stopped, bgKills: { count: 1, lastAt: ago(10) } }).triageReasons, ["后台进程随超时被杀"]);
  assert.equal(tri({ ...stopped, bgKills: { count: 3, lastAt: ago(120) } }).triage, "quiet");
  assert.deepEqual(tri({ status: "running", recentToolCalls: 30, distinctRecentCommands: 12, minutesSinceLastMessage: 10, bgKills: { count: 1, lastAt: ago(10) } }).triageReasons, ["后台进程随超时被杀"]);
});
