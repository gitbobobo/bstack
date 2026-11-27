import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadState, statePath, putHandoff, recordDecisions, resolveHandoff, managedThreadsOf } from "./patrol-state.mjs";

const entry = { sourceEnvironmentId: "mbp", sourceThreadId: "ios", sourceLink: "t3-thread://ios", targetEnvironmentId: "mini", canonicalKey: "host/repo", task: "Android 后续", handoffRef: "来源收尾消息", waitingSince: "2026-11-09T04:00:00Z", blocker: "Musiver 池 4/4" };

test("交接按来源环境及线程去重，更新保留最初等待时间；只有带证据的销账才删除", () => {
  const state = { lastRound: null, pendingHandoffs: [] };
  putHandoff(state, entry);
  putHandoff(state, { ...entry, waitingSince: "2026-11-09T07:00:00Z", blocker: "准备失败", launchedThreadLink: "t3-thread://android" });
  assert.equal(state.pendingHandoffs.length, 1);
  assert.equal(state.pendingHandoffs[0].waitingSince, entry.waitingSince);
  assert.equal(state.pendingHandoffs[0].blocker, "准备失败");
  putHandoff(state, { ...entry, sourceEnvironmentId: "other" });
  assert.equal(state.pendingHandoffs.length, 2);
  assert.throws(() => resolveHandoff(state, { ...entry, outcome: "accepted" }), /evidenceRef/);
  resolveHandoff(state, { ...entry, outcome: "accepted", evidenceRef: "目标线程实际调查活动" });
  assert.equal(state.pendingHandoffs.length, 1);
  assert.equal(state.pendingHandoffs[0].sourceEnvironmentId, "other");
  assert.throws(() => putHandoff(state, { ...entry, targetEnvironmentId: "" }), /targetEnvironmentId/);
});

test("归属只取派活记录和交接目标，队列销账后目标仍受管，台账损坏报错", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "patrol-ownership-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { BSTACK_CONFIG_DIR: dir };
  const state = { pendingHandoffs: [] };
  assert.deepEqual(managedThreadsOf(state, env), []);
  mkdirSync(join(dir, "state"));
  const ledger = join(dir, "state", "t3-dispatch.jsonl");
  writeFileSync(ledger, [
    { event: "launched", environmentId: "mini", threadId: "a", at: "2020-01-01" },
    { event: "released", environmentId: "mini", threadId: "a" },
    { event: "claimed", environmentId: "mini", threadId: "b" },
  ].map((x) => JSON.stringify(x)).join("\n"));
  const handoff = { ...entry, launchedThreadLink: "<t3-thread://v2/mini/android>" };
  putHandoff(state, handoff);
  putHandoff(state, handoff);
  assert.deepEqual(state.managedThreads, [{ environmentId: "mini", threadId: "android" }]);
  resolveHandoff(state, { ...entry, outcome: "accepted", evidenceRef: "接手活动" });
  assert.deepEqual(managedThreadsOf(state, env), [
    { environmentId: "mini", threadId: "android" }, { environmentId: "mini", threadId: "a" },
  ]);
  assert.deepEqual(managedThreadsOf({ pendingHandoffs: [handoff] }, env).map((x) => x.threadId), ["a", "android"], "旧队列可恢复目标归属，但不收编来源");
  writeFileSync(ledger, "broken");
  assert.throws(() => managedThreadsOf(state, env));
});

test("commit 保留交接队列；旧状态兼容，损坏状态报错而非清空", () => {
  const dir = mkdtempSync(join(tmpdir(), "patrol-state-"));
  const env = { ...process.env, BSTACK_CONFIG_DIR: dir };
  try {
    assert.deepEqual(loadState(env), { lastRound: null, pendingHandoffs: [], managedThreads: [], threads: {} });
    const path = statePath(env);
    const state = { lastRound: null, pendingHandoffs: [entry], managedThreads: [], threads: {} };
    const input = join(dir, "entry.json");
    writeFileSync(input, JSON.stringify(entry));
    const run = (...args) => {
      const r = spawnSync(process.execPath, [fileURLToPath(new URL("./patrol-state.mjs", import.meta.url)), ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    run("handoff-put", "--file", input);
    assert.deepEqual(loadState(env), state);
    const snap = join(dir, "snapshot.json");
    writeFileSync(snap, JSON.stringify({ generatedAt: "2026-11-09T07:00:00Z", triage: { full: false }, environments: [] }));
    run("commit", "--snapshot", snap);
    assert.deepEqual(loadState(env).pendingHandoffs, [entry]);
    assert.equal(loadState(env).lastRound.snapshotAt, "2026-11-09T07:00:00Z");
    assert.equal(loadState(env).lastRound.tier, undefined);
    assert.equal(loadState(env).lastRound.handoffQueueVersion, 1);
    writeFileSync(input, JSON.stringify({ ...entry, outcome: "accepted", evidenceRef: "目标调查活动" }));
    run("handoff-resolve", "--file", input);
    assert.deepEqual(loadState(env).pendingHandoffs, []);
    const second = { ...entry, sourceThreadId: "ios2" };
    writeFileSync(input, JSON.stringify([entry, second]));
    run("handoff-put", "--file", input);
    assert.deepEqual(loadState(env).pendingHandoffs.map((x) => x.sourceThreadId), ["ios", "ios2"], "一个文件批量入账");
    writeFileSync(input, JSON.stringify([{ ...entry, outcome: "accepted", evidenceRef: "接手活动" }, { ...second, outcome: "accepted" }]));
    const bad = spawnSync(process.execPath, [fileURLToPath(new URL("./patrol-state.mjs", import.meta.url)), "handoff-resolve", "--file", input], { env, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.equal(loadState(env).pendingHandoffs.length, 2, "批内有一项缺证据就整批不写");
    writeFileSync(input, JSON.stringify([{ ...entry, outcome: "accepted", evidenceRef: "接手活动" }, { ...second, outcome: "cancelled", evidenceRef: "来源撤销" }]));
    run("handoff-resolve", "--file", input);
    assert.deepEqual(loadState(env).pendingHandoffs, []);
    writeFileSync(path, JSON.stringify({ lastRound: { tier: "old" } }));
    assert.deepEqual(loadState(env), { lastRound: { tier: "old" }, pendingHandoffs: [], managedThreads: [], threads: {} });
    writeFileSync(path, "broken");
    assert.throws(() => loadState(env));
    assert.equal(readFileSync(path, "utf8"), "broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("线程状态表：同 kind 写动作连发计数，不打扰清零，复查时间按分钟，消失的线程丢弃", () => {
  const state = {};
  const now = Date.parse("2026-11-09T07:00:00Z");
  const d = { environmentId: "mini", threadId: "a", kind: "收尾", action: "send", waitFor: "pr-finish 收尾", recheckMinutes: 90 };
  recordDecisions(state, [d, { environmentId: "mini", threadId: "gone", kind: "x", action: "send" }], { now });
  recordDecisions(state, [d], { now, alive: new Set(["mini/a"]) });
  assert.deepEqual(state.threads["mini/a"], { kind: "收尾", action: "send", at: "2026-11-09T07:00:00.000Z", count: 2, waitFor: "pr-finish 收尾", recheckAt: "2026-11-09T08:30:00.000Z" });
  assert.equal(state.threads["mini/gone"], undefined);
  recordDecisions(state, [{ ...d, kind: "预算收口" }], { now });
  assert.equal(state.threads["mini/a"].count, 1, "换了动作重新计数");
  recordDecisions(state, [{ ...d, action: "none", kind: "不打扰", recheckMinutes: 0 }], { now });
  assert.equal(state.threads["mini/a"].count, 0);
  assert.equal(state.threads["mini/a"].recheckAt, undefined);
});

test("交接可带启动信息，缺字段拒绝", () => {
  const state = { pendingHandoffs: [] };
  putHandoff(state, { ...entry, launch: { projectId: "p", title: "#46 歌词-Android", message: "交接提示词" } });
  assert.equal(state.pendingHandoffs[0].launch.projectId, "p");
  const verification = { projectId: "p", title: "补截图", message: "只验证，不改代码", verificationOnly: true };
  putHandoff(state, { ...entry, launch: verification });
  assert.deepEqual(state.pendingHandoffs[0].launch, verification);
  assert.throws(() => putHandoff(state, { ...entry, launch: { ...verification, verificationOnly: "true" } }), /verificationOnly/);
  assert.throws(() => putHandoff(state, { ...entry, launch: { projectId: "p" } }), /launch 缺少 title/);
});
