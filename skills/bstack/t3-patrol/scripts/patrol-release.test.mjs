import { test } from "node:test";
import assert from "node:assert/strict";
import { occupancyDecision } from "./patrol-capacity.mjs";
import { putHandoff } from "./patrol-state.mjs";

const verifiedAt = "2026-11-18T16:40:00Z";
const sourceRelease = { runId: "r1", worktreePath: "/tree", verifiedAt, deliveryRef: "PR 本机段交付记录", idleRef: "本机进程/子代理核验记录" };
const base = {
  thread: { status: "completed", pullRequests: [] },
  details: { status: "completed", lastRunStatus: "completed", hasWorktree: true, worktreePath: "/tree", lastRunId: "r1", lastRunEndedAt: "2026-11-18T16:39:00Z" },
  handoff: { sourceRelease }, managed: true,
};

test("停止线程释放名额，与工作树、PR、交接凭据和待答请求无关", () => {
  const decide = (patch = {}) => occupancyDecision({ ...base, ...patch });
  for (const status of ["completed", "failed", "interrupted", "cancelled"]) {
    for (const prs of [[], [{ state: "open" }], [{ state: "merged" }]]) {
      assert.equal(decide({ thread: { status, pullRequests: prs }, details: { ...base.details, status, lastRunStatus: status } }).occupies, false);
    }
  }
  for (const patch of [
    { handoff: {} }, { managed: false },
    { details: { ...base.details, worktreePath: "/new-tree", lastRunId: "r2", pendingRequestCount: 1 } },
    { handoff: { sourceRelease: { ...sourceRelease, idleRef: "" } } },
  ]) assert.equal(decide(patch).occupies, false, JSON.stringify(patch));
});

test("活跃状态、run和后代仍占位；读取失败保留容量缺口", () => {
  for (const status of ["queued", "preparing", "starting", "running", "waiting"]) {
    for (const patch of [
      { thread: { ...base.thread, status } },
      { details: { ...base.details, status } },
      { details: { ...base.details, lastRunStatus: status } },
    ]) assert.equal(occupancyDecision({ ...base, ...patch }).occupies, true);
  }
  for (const patch of [{ liveChild: true }, { details: { ...base.details, activeRunId: "r2" } }, { details: { error: "不可读" } }]) {
    assert.equal(occupancyDecision({ ...base, ...patch }).occupies, true);
  }
});

test("交接更新只保留核验，其他字段沿用替换语义；允许撤回并拒绝不完整凭据", () => {
  const entry = { sourceEnvironmentId: "linux", sourceThreadId: "a", sourceLink: "t3-thread://v2/linux/a", targetEnvironmentId: "mbp", canonicalKey: "host/repo", task: "跨机后续", handoffRef: "交接消息", waitingSince: verifiedAt, blocker: "等待容量", sourceRelease };
  const state = { pendingHandoffs: [] };
  putHandoff(state, { ...entry, launchedThreadLink: "t3-thread://v2/mbp/b" });
  const { sourceRelease: ignored, ...update } = entry;
  putHandoff(state, { ...update, blocker: "仍等容量" });
  assert.deepEqual(state.pendingHandoffs[0].sourceRelease, sourceRelease);
  assert.equal(state.pendingHandoffs[0].launchedThreadLink, undefined, "省略目标链接仍按原替换语义清除，不静默复用陈旧目标");
  assert.equal(state.pendingHandoffs.length, 1, "核验不是交接销账");
  assert.throws(() => putHandoff(state, { ...entry, sourceRelease: { runId: "r1" } }), /sourceRelease/);
  assert.throws(() => putHandoff(state, { ...entry, sourceRelease: { ...sourceRelease, verifiedAt: "bad" } }), /verifiedAt/);
  putHandoff(state, { ...update, sourceRelease: null });
  assert.equal(state.pendingHandoffs[0].sourceRelease, null);
  putHandoff(state, { ...update, targetEnvironmentId: "mini" });
  assert.equal(state.pendingHandoffs[0].launchedThreadLink, undefined, "改目标环境不复用旧接手线程");
});
