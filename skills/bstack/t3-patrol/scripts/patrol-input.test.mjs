import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { parseArgs, threadInputs } from "./patrol-evidence.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "patrol-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name, data) => { const file = join(dir, name); writeFileSync(file, JSON.stringify(data)); return file; };
}
const evidence = { threads: [{ threadId: "mcp:launch:t", environmentId: "e", thread: { status: "failed", title: "任务" }, task: "原任务" }] };

test("文件输入覆盖快照、取证、台账、batch，按环境去重并保留失败定位", () => {
  const rows = threadInputs({ environments: [{ environmentId: "e", candidates: [{ id: "a", triage: "hot" }, { id: "q", triage: "quiet" }], failedThreads: [{ id: "a", status: "failed" }] }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "failed");
  assert.equal(threadInputs({ environments: [{ environmentId: "e", candidates: [{ id: "q", triage: "quiet" }] }] }, "hot").length, 0);
  assert.equal(threadInputs(evidence, "failed")[0].id, "mcp:launch:t");
  assert.equal(threadInputs({ active: [{ threadId: "a", environmentId: "e" }, { threadId: "a", environmentId: "other" }] }).length, 2);
  assert.equal(threadInputs({ calls: [{ threadId: "a", environmentId: "e", result: { status: "failed" } }] }, "failed")[0].environmentId, "e");
  const watch = [{ threadId: "watched", environmentId: "remote" }];
  assert.equal(threadInputs({ watch })[0].id, "watched");
  assert.deepEqual(threadInputs({ watch, calls: [{ ...watch[0], result: {} }, { threadId: "sent", environmentId: "e" }] }).map((t) => t.id), ["watched", "sent"]);
  assert.throws(() => threadInputs({ threads: [{}] }), /缺有效/);
  assert.throws(() => threadInputs({}), /输入须为/);
  assert.deepEqual(threadInputs([{ threadId: "launched", environmentId: "remote", status: "running" }, { title: "未建线", error: "认领失败" }]).map((t) => t.id), ["launched"]);
  assert.throws(() => threadInputs([{}]), /threadId/);
  assert.throws(() => threadInputs({ environments: [{ hot: [], quiet: [] }] }, "hot"), /brief/);
  assert.equal(threadInputs({ threads: [{ threadId: "unknown", error: "unreachable" }] }, "failed")[0].error, "unreachable");
});

test("CLI 参数合并文件与单条输入，空选集正常返回，拼错参数非零", (t) => {
  const put = fixture(t);
  const file = put("evidence.json", evidence);
  const opts = parseArgs(["--from", file, "--select", "failed", "--thread", "mcp:launch:t@e"]);
  assert.deepEqual(opts.threads, ["mcp:launch:t@e"]);
  for (const args of [["--from"], ["--select", "typo"], ["--items", "NaN"], ["--typo"]]) assert.throws(() => parseArgs(args));
  const empty = put("empty.json", { threads: [] });
  const r = spawnSync(process.execPath, [new URL("./patrol-evidence.mjs", import.meta.url).pathname, "--from", empty], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { threads: [], prs: [] });
});

test("恢复直接读取取证，dry-run 不要求会话且跳过用户取消", (t) => {
  const put = fixture(t);
  const snapshot = put("snapshot.json", { modelLadder: [{ instanceId: "pi", model: "test", fallback: true }], environments: [] });
  const from = put("evidence.json", { threads: [...evidence.threads, { threadId: "cancelled", thread: { status: "cancelled" } }] });
  const r = spawnSync(process.execPath, [new URL("./patrol-tier.mjs", import.meta.url).pathname, "--snapshot", snapshot, "--evidence", from, "--dry-run"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.count, 1);
  assert.equal(plan.plan[0].threadId, "mcp:launch:t");
  assert.equal(plan.plan[0].environmentId, "e");
  assert.equal(plan.skipped[0].reason, "cancelled");
  const unknown = put("unknown.json", { threads: [{ threadId: "unknown", environmentId: null, error: "unreachable" }] });
  for (const extra of [[], ["--dry-run"]]) {
    const failed = spawnSync(process.execPath, [new URL("./patrol-tier.mjs", import.meta.url).pathname, "--snapshot", snapshot, "--evidence", unknown, ...extra], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).unresolved[0].threadId, "unknown");
    assert.equal(JSON.parse(failed.stdout).count, 0);
  }
});

test("恢复刷新后保留已运行线程；回读仅认发送返回的 run", async (t) => {
  const put = fixture(t);
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    let result = {};
    if (rpc.method === "tools/call") {
      const { name, arguments: a } = rpc.params;
      calls.push({ name, a });
      if (name === "t3_thread_read") result = a.threadId === "active"
        ? { thread: { status: "running", activeRunId: "active-run" } }
        : { thread: { status: "failed" }, recentRuns: [{ runId: "unrelated", status: "completed" }] };
      if (name === "t3_thread_send") result = { runId: "sent-run", status: "queued" };
      const failure = (a.threadId === "bad-refresh" && name === "t3_thread_read") || (a.threadId === "bad-configure" && name === "t3_thread_configure") || (a.threadId === "bad-send" && name === "t3_thread_send");
      result = failure ? { isError: true, content: [{ text: "模拟工具失败" }] } : { structuredContent: result };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const snapshot = put("snapshot.json", { modelLadder: [{ instanceId: "pi", model: "test", fallback: true }] });
  const from = put("evidence.json", { threads: [...evidence.threads,
    { threadId: "local-pr", environmentId: null, thread: { status: "failed", pullRequests: ["https://forge.test/owner/repo/pulls/42:open"] } },
    { threadId: "unknown", environmentId: "e", error: "取证失败" },
    ...["active", "bad-refresh", "bad-configure", "bad-send"].map((threadId) => ({ threadId, environmentId: "e", thread: { status: "failed" } }))] });
  const child = spawn(process.execPath, [new URL("./patrol-tier.mjs", import.meta.url).pathname, "--snapshot", snapshot, "--evidence", from], { env: { PATH: process.env.PATH, T3_MCP_URL: `http://127.0.0.1:${server.address().port}`, T3_MCP_BEARER_TOKEN: "test-only" } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b);
  child.stderr.on("data", (b) => stderr += b);
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.count, 2);
  assert.equal(result.unresolved[0].threadId, "unknown");
  assert.ok(!calls.some((c) => c.a.threadId === "unknown"));
  assert.ok(calls.filter((c) => c.a.threadId === "local-pr").every((c) => !Object.hasOwn(c.a, "environmentId")));
  assert.match(calls.find((c) => c.name === "t3_thread_send" && c.a.threadId === "local-pr").a.message, /处理 PR #42/);
  assert.ok(!calls.find((c) => c.name === "t3_thread_send" && c.a.threadId === "mcp:launch:t").a.message.includes("继续：继续："));
  assert.equal(result.sent[0].verify, "no-run");
  assert.equal(result.skipped[0].threadId, "active");
  assert.deepEqual(result.errors.map((e) => [e.threadId, e.stage, e.configured]), [["bad-refresh", "refresh", false], ["bad-configure", "configure", false], ["bad-send", "send", true]]);
  assert.equal(calls.filter((c) => c.name === "t3_thread_send").length, 3);
  assert.ok(!calls.some((c) => c.name === "t3_thread_configure" && c.a.threadId === "active"));

  const batchFile = put("calls.json", [{ label: "先成功发送", tool: "t3_thread_send", args: { environmentId: "e", threadId: "active" } }, { tool: "t3_thread_read", args: null }, null]);
  const batch = spawn(process.execPath, [new URL("./patrol-batch.mjs", import.meta.url).pathname, "--calls", batchFile], { env: { PATH: process.env.PATH, T3_MCP_URL: `http://127.0.0.1:${server.address().port}`, T3_MCP_BEARER_TOKEN: "test-only" } });
  t.after(() => { if (batch.exitCode === null) batch.kill(); });
  let batchOut = "", batchErr = "";
  batch.stdout.on("data", (b) => batchOut += b);
  batch.stderr.on("data", (b) => batchErr += b);
  assert.equal(await new Promise((resolve) => batch.on("close", resolve)), 1, batchErr);
  assert.equal(JSON.parse(batchOut).calls[0].result.runId, "sent-run");
  assert.deepEqual(JSON.parse(batchOut).calls.map((c) => c.ok), [true, false, false]);
  assert.equal(threadInputs(JSON.parse(batchOut))[0].threadId, "active");
  assert.equal(threadInputs(JSON.parse(batchOut))[0].environmentId, "e");
});
