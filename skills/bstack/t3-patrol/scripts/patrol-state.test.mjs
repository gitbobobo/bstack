import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadState, statePath, putHandoff, resolveHandoff } from "./patrol-state.mjs";

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

test("commit 保留交接队列；旧状态兼容，损坏状态报错而非清空", () => {
  const dir = mkdtempSync(join(tmpdir(), "patrol-state-"));
  const env = { ...process.env, BSTACK_CONFIG_DIR: dir };
  try {
    assert.deepEqual(loadState(env), { lastRound: null, pendingHandoffs: [] });
    const path = statePath(env);
    const state = { lastRound: null, pendingHandoffs: [entry] };
    const input = join(dir, "entry.json");
    writeFileSync(input, JSON.stringify(entry));
    const run = (...args) => {
      const r = spawnSync(process.execPath, [new URL("./patrol-state.mjs", import.meta.url).pathname, ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    run("handoff-put", "--file", input);
    assert.deepEqual(loadState(env), state);
    const snap = join(dir, "snapshot.json");
    writeFileSync(snap, JSON.stringify({ generatedAt: "2026-11-09T07:00:00Z", triage: { full: false }, environments: [] }));
    run("commit", "--snapshot", snap, "--tier", "preferred");
    assert.deepEqual(loadState(env).pendingHandoffs, [entry]);
    assert.equal(loadState(env).lastRound.tier, "preferred");
    assert.equal(loadState(env).lastRound.handoffQueueVersion, 1);
    writeFileSync(input, JSON.stringify({ ...entry, outcome: "accepted", evidenceRef: "目标调查活动" }));
    run("handoff-resolve", "--file", input);
    assert.deepEqual(loadState(env).pendingHandoffs, []);
    writeFileSync(path, JSON.stringify({ lastRound: { tier: "old" } }));
    assert.deepEqual(loadState(env), { lastRound: { tier: "old" }, pendingHandoffs: [] });
    writeFileSync(path, "broken");
    assert.throws(() => loadState(env));
    assert.equal(readFileSync(path, "utf8"), "broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
