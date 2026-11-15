import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const REPO = "host/owner/heavy";

test("完整/容量快照一致排除 Fast Ship 审查，保留实现父线程与失败清单", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "patrol-snapshot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "t3-patrol.json"), JSON.stringify({ capacity: { pools: { heavy: 5, general: 2 }, projects: [{ repo: REPO, pool: "heavy" }], minFreeDiskGB: 0 } }));
  writeFileSync(join(dir, "environments.json"), JSON.stringify({ environments: { mini: { environmentId: "mini", device: "mini", os: "macos" } } }));
  const now = new Date().toISOString();
  const thread = (id, title, status, extra = {}) => ({ threadId: id, title, status, projectId: "p", itemCount: 2, providerInstanceId: "pi", model: "fixture", pullRequests: [], ...extra });
  const top = [
    ...["running", "starting", "waiting", "failed", "completed"].map((s, i) => thread(`impl${i}`, `INT-${i} 实现`, s)),
    thread("review0", "代码审查 · PR #208", "running"),
    thread("review1", "代码审查 · PR #228", "failed"),
    thread("review2", "视觉审查 · PR #205", "completed"),
    thread("self", "改过名的当前巡检", "running"),
    thread("background", "INT-200 race后台验收", "completed"),
    thread("discussion", "讨论备选方案", "completed"),
    thread("unreadable", "绑定读取失败的验收", "completed"),
    thread("merged", "已合并的交付", "completed", { pullRequests: [{ state: "merged", repository: "owner/heavy", number: 11 }] }),
  ];
  top.find((x) => x.threadId === "impl3").title = "视觉审查 · PR #228 修复";
  top.find((x) => x.threadId === "impl4").title = "代码审查 · PR #208 重验证";
  top.find((x) => x.threadId === "impl3").pullRequests = [{ state: "open", repository: "owner/heavy", number: 3 }];
  for (const r of top.filter((x) => x.threadId.startsWith("review"))) r.pullRequests = [{ state: "open", repository: "owner/heavy", number: 10 }];
  const children = [thread("child1", "实现子代理", "running", { parentThreadId: "impl4" }), thread("child2", "审查子代理", "running", { parentThreadId: "review2" })];
  const reads = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      let result = {};
      if (rpc.method === "tools/call") {
        const { name, arguments: a } = rpc.params;
        let data;
        if (name === "t3_environment_links") data = { environmentId: "mini", links: [] };
        else if (name === "t3_thread_list") data = { threads: a.includeSubagents ? children : top, nextCursor: null };
        else if (name === "t3_project_list") data = { projects: [{ id: "p", repositoryIdentity: { canonicalKey: REPO } }], nextCursor: null };
        else if (name === "list_thread_pull_requests") data = { pullRequests: [] };
        else if (name === "t3_thread_read") {
          reads.push(a.threadId);
          if (a.threadId === "unreadable") {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ text: "fixture 绑定读取失败" }] } }));
            return;
          }
          const tr = top.find((x) => x.threadId === a.threadId);
          assert.ok(tr, `未知线程 ${a.threadId}`);
          data = { thread: { ...tr, worktreePath: tr.threadId === "discussion" ? null : "/fixture/worktree" },
            items: [{ position: 0, type: "user_message", text: "实现这个问题", updatedAt: now }, { position: 1, type: "assistant_message", text: "有实际实现进展", updatedAt: now }],
            recentRuns: [{ ordinal: 1, status: tr.status, startedAt: now, completedAt: now }], hasMore: false };
        } else throw new Error(`未模拟的工具 ${name}`);
        result = { structuredContent: data };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (e) {
      errors.push(String(e));
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { PATH: process.env.PATH, HOME: dir, BSTACK_CONFIG_DIR: dir,
    T3_MCP_URL: `http://127.0.0.1:${server.address().port}`, T3_MCP_BEARER_TOKEN: "fixture-only" };
  const script = new URL("./patrol-snapshot.mjs", import.meta.url).pathname;
  for (const mode of [["--capacity-only"], []]) {
    reads.length = 0;
    const { stdout, stderr } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const e = JSON.parse(stdout).environments[0];
    assert.equal(e.error, undefined, stderr || e.error);
    assert.equal(e.capacity.used, 7);
    assert.equal(e.activeTopLevel, 7);
    assert.equal(e.capacity.pools[0].used, 7);
    assert.equal(e.capacity.unverifiedThreads[0].threadId, "unreadable", "读取失败不能悄悄释放名额");
    assert.ok(e.occupying.includes("INT-200 race后台验收"), "无PR的后台验收在代理回合completed后仍占位");
    assert.ok(!e.occupying.includes("讨论备选方案"));
    assert.ok(!e.occupying.includes("已合并的交付"));
    assert.equal(e.capacity.freeByRepo[REPO], 0);
    assert.ok(!e.occupying.some((s) => /^(代码|视觉)审查 · PR #\d+$/.test(s)));
    assert.ok(e.occupying.includes("代码审查 · PR #208 重验证"), "带后缀的实现父线程等待子代理时仍占位");
    assert.ok(e.occupying.includes("视觉审查 · PR #228 修复"), "带后缀的失败实现线程仍占位并进入恢复");
    assert.ok(!reads.some((id) => id.startsWith("review")), "审查线程不为容量或失败恢复补读");
    if (!mode.length) {
      assert.deepEqual(e.failedThreads.map((x) => x.id), ["impl3"], "审查失败由 Fast Ship 处理，普通失败仍进恢复清单");
      assert.equal(e.checks.candidates, 9);
    }
  }
  const { stdout } = await exec(process.execPath, [script, "--self", "self", "--capacity-only",
    "--expect-release", "impl0@mini", "--expect-release", "impl2@mini", "--expect-release", "background",
    "--expect-release", "impl1@other", "--expect-release", "ghost@mini"], { env, timeout: 15000 });
  const snap = JSON.parse(stdout);
  const c = snap.environments[0].capacity;
  assert.equal(c.freeByRepo[REPO], 0, "预计释放不改实际空位");
  assert.equal(c.projectedFreeByRepo[REPO], 1, "7 占 5 位，三个预计释放后余 1");
  assert.deepEqual(c.releasing.map((x) => x.threadId).sort(), ["background", "impl0", "impl2"]);
  assert.deepEqual(snap.expectReleaseUnmatched.map((x) => x.threadId).sort(), ["ghost", "impl1"], "别的环境或不占位的线程要报出来核对");

  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "state", "t3-patrol.json"), JSON.stringify({ pendingHandoffs: [
    { sourceEnvironmentId: "mini", sourceThreadId: "impl2", launchedThreadLink: "<t3-thread://x>" },
    { sourceEnvironmentId: "mini", sourceThreadId: "impl1" },
  ] }));
  const batch = join(dir, "batch.json");
  writeFileSync(batch, JSON.stringify({ calls: [
    { label: "收尾指令（无模板）", tool: "t3_thread_send", threadId: "impl0", environmentId: "mini", releases: true, ok: true },
    { label: "M9 未标", tool: "t3_thread_send", threadId: "background", environmentId: "mini", ok: true },
    { label: "M10 发送失败", tool: "t3_thread_send", threadId: "impl4", environmentId: "mini", releases: true, ok: false },
    { label: "改名", tool: "t3_thread_update", threadId: "impl3", environmentId: "mini", ok: true },
  ] }));
  const { stdout: out2 } = await exec(process.execPath, [script, "--self", "self", "--capacity-only", "--expect-release-from", batch], { env, timeout: 15000 });
  const snap2 = JSON.parse(out2);
  const c2 = snap2.environments[0].capacity;
  assert.deepEqual(c2.releasing.map((x) => x.threadId).sort(), ["impl0", "impl2"], "带 releases 的成功调用与已建线交接来源记为预计释放");
  assert.deepEqual(snap2.expectReleaseUnflagged.map((x) => x.threadId), ["background"], "发过消息、仍占位却没标 releases 的要报出来");
  assert.equal(snap2.expectReleaseUnmatched, undefined);
  assert.deepEqual(errors, []);
});
