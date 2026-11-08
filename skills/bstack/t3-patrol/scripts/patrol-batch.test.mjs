import { test } from "node:test";
import assert from "node:assert/strict";
import { brief } from "./patrol-batch.mjs";

test("返回值只留判定字段；没有已知字段时截断原文", () => {
  assert.deepEqual(brief({ messageId: "m", runId: "r", junk: "x".repeat(500) }), { messageId: "m", runId: "r" });
  assert.deepEqual(brief({ thread: { threadId: "t", status: "running", items: [] } }), { threadId: "t", status: "running" });
  assert.equal(typeof brief({ other: 1 }), "string");
  assert.equal(brief(null), null);
});
