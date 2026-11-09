import { test } from "node:test";
import assert from "node:assert/strict";
import { briefOf } from "./patrol-brief.mjs";

test("摘要：有事候选留判定字段并截断尾部，静默一行，体检清单只给要动手的条目", () => {
  const snap = {
    generatedAt: "g",
    triage: { full: false, since: "s" },
    modelLadder: [{ name: "pi/x" }],
    config: { warnings: [], errors: [] },
    environments: [
      {
        alias: "pc",
        environmentId: "e",
        checks: { candidates: 2 },
        capacity: { used: 1, max: 5, freeByRepo: { a: 0, b: 2 }, disk: { freeGB: null } },
        candidates: [
          { id: "t1", link: "<l1>", title: "#1 x", status: "completed", triage: "hot", triageReasons: ["上轮后有新活动"], tail: ["x".repeat(900)], pendingRequestCount: 0, model: "m", prHealth: [{ pr: "#1", host: "h", checks: [{ name: "代码审查", state: "pending", at: "2026-11-08T10:00:00Z" }] }] },
          { id: "t2", link: "<l2>", title: "#2 y", status: "running", triage: "quiet", triageReasons: ["在跑，信号正常"] },
        ],
        failedThreads: [{ id: "f", title: "z", tail: ["t"], task: "k" }],
        needsWatchThreads: [{ id: "t1" }],
        needsRenameThreads: [],
      },
    ],
  };
  const b = briefOf(snap);
  const e = b.environments[0];
  assert.deepEqual(e.capacity, { used: 1, max: 5, free: { b: 2 } });
  assert.equal(e.hot.length, 1);
  assert.equal(e.hot[0].model, undefined);
  assert.equal(e.hot[0].pendingRequestCount, undefined);
  assert.ok(e.hot[0].tail[0].length <= 401);
  assert.match(e.hot[0].prHealth[0].checks[0], /^代码审查:pending@11-08T10:00/);
  assert.match(e.quiet[0], /^#2 y（在跑，信号正常） <l2>$/);
  assert.deepEqual(e.failedThreads, [{ id: "f", title: "z" }]);
  assert.equal(e.needsWatch, 1);
  assert.deepEqual(b.modelLadder, ["pi/x"]);
  assert.deepEqual(b.pendingHandoffs, []);
});

test("待交接队列独立展示：来源不在候选或环境不可达仍完整保留", () => {
  const pendingHandoffs = [{ sourceThreadId: "ios", targetEnvironmentId: "mini", canonicalKey: "o/r", blocker: "池满" }];
  const b = briefOf({ pendingHandoffs, environments: [{ environmentId: "mini", error: "offline" }] });
  assert.deepEqual(b.pendingHandoffs, pendingHandoffs);
  assert.equal(b.environments[0].error, "offline");
});
