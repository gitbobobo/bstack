import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const script = fileURLToPath(new URL("./t3-activity-scan.mjs", import.meta.url));
const exec = promisify(execFile);

test("扫描保留完整技能名，识别 Devin 调用并排除本线程", async (t) => {
  const updatedAt = new Date().toISOString();
  const items = [
    { type: "user_message", text: "x".repeat(392) + " $pr-review-loop $body" + "x".repeat(4400) + " $test-audit" },
    { type: "assistant_message", text: "$pr-review-loop $pr-review-lo" },
    { type: "dynamic_tool", title: "Invoked skill pr-review-loop", text: '{"toolName":"Invoked skill pr-review-loop"}' },
    { type: "dynamic_tool", text: '{"toolName":"Invoked skill git-prefs"}' },
    { type: "command_execution", text: "cat skills/general/test-audit/SKILL.md $pr-review-loop" },
    { type: "reasoning", text: "$test-audit " + "x".repeat(500) },
  ].map((item, position) => ({ ...item, position, updatedAt, itemId: String(position) }));
  const threads = ["current", "other"].map((threadId) => ({ threadId, updatedAt, itemCount: items.length }));
  const offsets = [];
  const scanned = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    const { name, arguments: args } = params;
    const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    if (method === "initialize") return reply({});
    const replyTool = (structuredContent) => reply({ structuredContent });
    switch (name) {
      case "t3_environment_links":
        return replyTool({ environmentId: "local", links: [] });
      case "t3_thread_list":
        return replyTool({ threads, currentThreadId: "current", nextCursor: null });
      case "t3_thread_read": {
        if (!args.view) {
          scanned.push(args.threadId);
          return replyTool({ items: items.slice(0, 1), recentRuns: [{ completedAt: updatedAt }], thread: { createdAt: updatedAt, status: "completed" } });
        }
        const offset = args.textOffset ?? 0;
        const window = args.itemId === undefined
          ? items.filter((item) => item.position > (args.afterPosition ?? -1))
          : items.filter((item) => item.itemId === args.itemId);
        if (args.itemId !== undefined) offsets.push([args.itemId, offset]);
        return replyTool({
          hasMore: false,
          items: window.map((item) => {
            const end = offset + args.maxCharsPerItem;
            const textTruncated = item.text.length > end;
            return { ...item, text: item.text.slice(offset, end), textTruncated, nextTextOffset: textTruncated ? end : null };
          }),
        });
      }
      default:
        res.statusCode = 400;
        return res.end(JSON.stringify({ id, error: { message: `意外的调用 ${name}` } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [script, ...args], {
      env: { ...process.env, T3_ACP_MCP_ENDPOINT: `http://127.0.0.1:${server.address().port}`, T3_ACP_MCP_AUTHORIZATION: "Bearer fixture" },
    });
    return JSON.parse(stdout).environments[0].threads[0];
  };

  const result = await run();
  assert.deepEqual(scanned, ["other"]);
  assert.equal(result.id, "other");
  assert.deepEqual(result.mentions, { "pr-review-loop": 2, "test-audit": 1 });
  assert.deepEqual(result.skillReads, ["pr-review-loop", "git-prefs", "test-audit"]);
  assert.equal(result.users[0].text.length, 400);
  assert.deepEqual(offsets, [["0", 400], ["0", 4400]]);

  const explicitSelf = await run("--self", "other");
  assert.equal(explicitSelf.id, "current");
  assert.deepEqual(scanned, ["other", "current"]);
});
