import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  mkdirSync(join(dir, "state"));
  const ledger = join(dir, "state", "t3-dispatch.jsonl");
  const records = top.map((tr) => ({ event: "launched", environmentId: "mini", threadId: tr.threadId, at: "2020-01-01T00:00:00Z" }));
  writeFileSync(ledger, records.map((r) => JSON.stringify(r)).join("\n"));
  const reads = [];
  let malformedThread = null;
  let middleFlakyReads = 0;
  const detailReads = [];
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
        else if (name === "list_thread_pull_requests") {
          detailReads.push(a.threadId);
          data = { pullRequests: [] };
        }
        else if (name === "t3_thread_read") {
          reads.push(a.threadId);
          if (a.view === "activity") detailReads.push(a.threadId);
          if (a.threadId === malformedThread) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: {} } }));
            return;
          }
          if (["unreadable", "middle-unreadable"].includes(a.threadId) || (a.threadId === "middle-flaky" && ++middleFlakyReads === 1)) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ text: "fixture 绑定读取失败" }] } }));
            return;
          }
          const tr = top.find((x) => x.threadId === a.threadId)
            ?? (a.threadId === "middle-flaky" ? thread("middle-flaky", "已停中间子代理", "completed", { parentThreadId: "background" }) : null);
          assert.ok(tr, `未知线程 ${a.threadId}`);
          data = { thread: { ...tr, worktreePath: tr.threadId === "discussion" ? null : "/fixture/worktree" },
            items: [{ position: 0, type: "user_message", text: "实现这个问题", updatedAt: now }, { position: 1, type: "assistant_message", text: "有实际实现进展", updatedAt: now }],
            recentRuns: [{ runId: `run-${tr.threadId}`, ordinal: 1, status: tr.status, startedAt: now, completedAt: now }], hasMore: false };
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
  const script = fileURLToPath(new URL("./patrol-snapshot.mjs", import.meta.url));
  for (const mode of [["--capacity-only"], []]) {
    reads.length = 0;
    const { stdout, stderr } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const e = JSON.parse(stdout).environments[0];
    assert.equal(e.error, undefined, stderr || e.error);
    assert.equal(e.capacity.used, 5);
    assert.equal(e.activeTopLevel, 5);
    assert.equal(e.capacity.pools[0].used, 5);
    assert.equal(e.capacity.unverifiedThreads[0].threadId, "unreadable", "读取失败不能悄悄释放名额");
    assert.ok(!e.occupying.includes("INT-200 race后台验收"), "completed与绑定工作树不构成活跃执行");
    assert.ok(!e.occupying.includes("讨论备选方案"));
    assert.ok(!e.occupying.includes("已合并的交付"));
    assert.equal(e.capacity.freeByRepo[REPO], 0);
    assert.ok(!e.occupying.some((s) => /^(代码|视觉)审查 · PR #\d+$/.test(s)));
    assert.ok(e.occupying.includes("代码审查 · PR #208 重验证"), "带后缀的实现父线程等待子代理时仍占位");
    assert.ok(!e.occupying.includes("视觉审查 · PR #228 修复"), "失败线程不因open PR占位，但仍进入恢复");
    assert.ok(!reads.some((id) => id.startsWith("review")), "审查线程不为容量或失败恢复补读");
    if (!mode.length) {
      assert.deepEqual(e.failedThreads.map((x) => x.id), ["impl3"], "审查失败由 Fast Ship 处理，普通失败仍进恢复清单");
      assert.equal(e.checks.candidates, 9);
    }
  }
  // 本机段已交付仅等待异机交接：两种快照均释放，但既不 settle 也不销账。
  const handoff = { sourceEnvironmentId: "mini", sourceThreadId: "background", targetEnvironmentId: "mbp",
    sourceRelease: { runId: "run-background", worktreePath: "/fixture/worktree", verifiedAt: new Date().toISOString(), deliveryRef: "本机交付", idleRef: "无后台任务核验" } };
  const stateFile = join(dir, "state", "t3-patrol.json");
  const pending = [handoff, ...["impl4", "unreadable"].map((id) => ({ ...handoff, sourceThreadId: id, sourceRelease: { ...handoff.sourceRelease, runId: `run-${id}` } }))];
  writeFileSync(stateFile, JSON.stringify({ pendingHandoffs: pending }));
  for (const mode of [["--capacity-only"], []]) {
    const { stdout } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const snap = JSON.parse(stdout);
    assert.equal(snap.environments[0].capacity.used, 5);
    assert.ok(!snap.environments[0].occupying.includes("INT-200 race后台验收"));
    const d = snap.environments[0].capacity.decisions.find((x) => x.threadId === "background");
    assert.equal(d.occupies, false);
    assert.match(d.reason, /线程已停止/);
    assert.equal(snap.pendingHandoffs.length, 3);
    assert.equal(snap.environments[0].capacity.decisions.find((x) => x.threadId === "impl4").occupies, true, "有活跃子代理，凭据不能释放");
    assert.equal(snap.environments[0].capacity.decisions.find((x) => x.threadId === "unreadable").occupies, true, "读取失败，凭据不能释放");
    if (mode.length) assert.ok(snap.environments[0].openThreads.some((x) => x.id === "background"), "释放容量不丢失查重身份");
  }
  malformedThread = "background";
  for (const mode of [["--capacity-only"], []]) {
    const { stdout } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const c = JSON.parse(stdout).environments[0].capacity;
    assert.equal(c.used, 6, "缺少 thread 的响应仍保守占位");
    assert.ok(c.unverifiedThreads.some((x) => x.threadId === "background"));
  }
  malformedThread = null;
  children.push(thread("flaky-grandchild", "祖先回读抖动的孙子代理", "running", { parentThreadId: "middle-flaky" }));
  for (const mode of [["--capacity-only"], []]) {
    middleFlakyReads = 0;
    const { stdout } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const e = JSON.parse(stdout).environments[0];
    assert.equal(e.error, undefined, "祖先瞬时错误重试成功不应停派");
    assert.equal(middleFlakyReads, 2);
    assert.equal(e.capacity.used, 6, "重试找回活跃孙子的来源后仍占位");
  }
  children.pop();
  // 中间层已停而孙子仍活跃；祖先读取失败不得将已核验来源误放行。
  children.push(thread("nested-child", "活跃孙子代理", "running", { parentThreadId: "middle-unreadable" }));
  for (const mode of [["--capacity-only"], []]) {
    const { stdout } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const e = JSON.parse(stdout).environments[0];
    assert.match(e.error, /绑定读取失败/);
    assert.equal(e.capacity, undefined, "祖先取证失败不得输出可派容量");
  }
  children.pop();
  // 旧凭据失效不改变当前已停止状态。
  handoff.sourceRelease.runId = "old-run";
  writeFileSync(stateFile, JSON.stringify({ pendingHandoffs: [handoff] }));
  for (const mode of [["--capacity-only"], []]) {
    const { stdout } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    assert.equal(JSON.parse(stdout).environments[0].capacity.used, 5);
  }
  // 线程状态表的复查时间压住持续条件：impl3 失败仍有事，completed 的 merged 线程本就静默。
  writeFileSync(stateFile, JSON.stringify({ pendingHandoffs: [], threads: { "mini/background": { kind: "等门禁", waitFor: "门禁结果", recheckAt: new Date(Date.now() + 3600000).toISOString() } } }));
  {
    const { stdout } = await exec(process.execPath, [script, "--self", "self"], { env, timeout: 15000 });
    const e = JSON.parse(stdout).environments[0];
    assert.deepEqual(e.projects, [{ id: "p", canonicalKey: REPO }], "完整快照带项目清单，供题库算各仓库可用池");
    assert.equal(e.candidates.find((x) => x.id === "background").hold.waitFor, "门禁结果");
  }
  // 没有派出归属的线程保留实际容量，但失败兜底、全量与独立体检都不能将它们捞回。
  const protectedIds = ["impl0", "impl3", "background", "discussion"];
  writeFileSync(ledger, records.filter((r) => !protectedIds.includes(r.threadId)).concat([
    { event: "launched", environmentId: "other", threadId: "impl3" }, // 同名异环境不能冒认
    { event: "claimed", environmentId: "mini", threadId: "impl0" }, // 认领不等于派出
  ]).map((r) => JSON.stringify(r)).join("\n"));
  for (const mode of [[], ["--full"], ["--capacity-only"]]) {
    detailReads.length = 0;
    const { stdout } = await exec(process.execPath, [script, "--self", "self", ...mode], { env, timeout: 15000 });
    const e = JSON.parse(stdout).environments[0];
    assert.equal(e.capacity.used, 5, "归属排除不释放实际占用");
    assert.ok(!detailReads.some((id) => protectedIds.includes(id)), "排除项仅可读容量元数据，不取活动或PR实况");
    if (mode.includes("--capacity-only")) {
      assert.ok(e.openThreads.some((x) => x.id === "impl0"), "派活查重仍保留非巡检线程");
      continue;
    }
    assert.equal(e.checks.candidates, 5);
    assert.equal(e.checks.patrolExcluded, 4);
    assert.deepEqual(e.patrolExcluded.map((x) => [x.id, x.reason]), protectedIds.map((id) => [id, "非巡检派出"]));
    for (const key of ["candidates", "failedTopLevel", "failedThreads", "needsWatchThreads", "needsRenameThreads", "convergenceAuditThreads"]) {
      assert.ok(!e[key].some((x) => protectedIds.includes(x.id)), `${key} 不得包含排除项`);
    }
  }
  assert.deepEqual(errors, []);
});
