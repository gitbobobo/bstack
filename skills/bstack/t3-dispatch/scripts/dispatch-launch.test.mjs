import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const REPO = "host/owner/fast_ship";

test("真实CLI链：错绑在认领前拒绝；分页核身份，正确派活结果可直接回读", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, "api.jsonl");
  const issueFile = join(dir, "issue.json");
  const api = join(dir, "api.mjs");
  writeFileSync(issueFile, JSON.stringify({ id: "issue", reference: "INT-200", title: "race验收", state: "open", project_id: "source-project", internal_meta: { workflow_status: "" }, body: "验收三次", collab: { consensus: "已确认" } }));
  writeFileSync(api, `import fs from 'node:fs';
const [method,path,body]=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({method,path})+'\\n');
let issue=JSON.parse(fs.readFileSync(${JSON.stringify(issueFile)},'utf8'));
if(method==='PUT'){issue.internal_meta=JSON.parse(fs.readFileSync(body,'utf8'));fs.writeFileSync(${JSON.stringify(issueFile)},JSON.stringify(issue));}
console.log(JSON.stringify({code:0,data:issue}));`);
  writeFileSync(join(dir, "t3-dispatch.json"), JSON.stringify({ mode: "auto", repos: [{ repo: REPO, source: "fast-ship", project: "source-project", statuses: ["unset"] }] }));
  const calls = [];
  let unreadable = false;
  let failSecond = false;
  let failOnceSecond = false;
  let repeatCursor = false;
  let searchFails = false;
  let historicalSettled = true;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const b of req) body += b;
    const rpc = JSON.parse(body);
    let result = {};
    if (rpc.method === "tools/call") {
      const { name, arguments: a } = rpc.params;
      calls.push({ name, a });
      let data;
      if (name === "t3_environment_links") data = { environmentId: "local", links: [{ environmentId: "remote", status: "reachable" }] };
      else if (name === "t3_project_list") {
        if (unreadable || ((failSecond || failOnceSecond) && a.cursor === 100)) {
          failOnceSecond = false;
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ text: "项目不可读" }] } })); return;
        }
        data = a.cursor === 100
          ? { projects: [{ id: "correct", repositoryIdentity: { canonicalKey: REPO } }], nextCursor: repeatCursor ? 100 : null }
          : { projects: [{ id: "wrong", repositoryIdentity: { canonicalKey: "host/owner/musiver" } }, { id: "correct-first", repositoryIdentity: { canonicalKey: REPO } }], nextCursor: 100 };
      } else if (name === "t3_thread_search") {
        if (searchFails) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ text: "搜索不可读" }] } })); return;
        }
        data = { matches: [{ threadId: "historical", title: "INT-200 仅讨论共识", source: "title", link: "<historical>" }] };
      }
      else if (name === "t3_thread_launch") data = { threadId: "launched", link: "<test-thread>" };
      else if (name === "t3_thread_read" && a.threadId === "historical") data = {
        thread: { threadId: "historical", title: "INT-200 仅讨论共识", settled: historicalSettled, archived: false, link: "<historical>" },
      };
      else if (name === "t3_thread_read") data = {
        thread: { threadId: "launched", title: "INT-200 race验收", status: "running", worktreePath: "/fixture/fast_ship", providerInstanceId: "pi", model: "test", itemCount: 2 },
        recentRuns: [{ runId: "run", status: "running" }],
        items: [{ type: "user_message", text: "验收三次", position: 0 }], hasMore: false,
      };
      else throw new Error(`未模拟 ${name}`);
      result = { structuredContent: data };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { PATH: process.env.PATH, HOME: dir, BSTACK_CONFIG_DIR: dir, FAST_SHIP_API: api,
    T3_MCP_URL: `http://127.0.0.1:${server.address().port}`, T3_MCP_BEARER_TOKEN: "fixture-only", T3_DISPATCH_READBACK_STEP_MS: "0" };
  const file = join(dir, "plan.json");
  const plan = (projectId, environmentId = "remote") => ({ launches: [{ repo: REPO, ids: ["issue"], environmentId, projectId, title: "INT-200 race验收", reason: "原任务验收" }] });
  const run = async (data) => {
    writeFileSync(file, JSON.stringify(data));
    try { return { code: 0, ...(await exec(process.execPath, [fileURLToPath(new URL("./dispatch-launch.mjs", import.meta.url)), "--plan", file], { env, timeout: 10000 })) }; }
    catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  };
  writeFileSync(file, JSON.stringify(plan("wrong")));
  const dry = await exec(process.execPath, [fileURLToPath(new URL("./dispatch-launch.mjs", import.meta.url)), "--plan", file, "--dry-run"], { env, timeout: 10000 });
  assert.equal(JSON.parse(dry.stdout).projectBinding, "not-checked");
  assert.equal(calls.length, 0, "dry-run只校验格式，无MCP或认领副作用");
  for (const environmentId of ["remote", "local"]) {
    const bad = await run(plan("wrong", environmentId));
    assert.equal(bad.code, 1, bad.stderr || bad.stdout);
    assert.match(JSON.parse(bad.stdout)[0].error, /项目|仓库/);
    assert.equal(existsSync(trace), false, "身份不符不能读来源、更不能认领");
    assert.ok(!calls.some((c) => c.name === "t3_thread_launch"));
  }
  unreadable = true;
  const missing = await run(plan("correct"));
  assert.equal(missing.code, 1);
  assert.equal(existsSync(trace), false, "查不到身份时保守停派");
  unreadable = false;
  failSecond = true;
  const partial = await run(plan("correct-first"));
  assert.equal(partial.code, 1, "第一页命中目标、第二页失败仍应停派");
  assert.equal(existsSync(trace), false, "半截清单不能触发来源读取或认领");
  assert.ok(!calls.some((c) => c.name === "t3_thread_launch"));
  failSecond = false;
  repeatCursor = true;
  const repeated = await run(plan("correct"));
  assert.equal(repeated.code, 1);
  assert.match(JSON.parse(repeated.stdout)[0].error, /游标重复/);
  assert.equal(existsSync(trace), false);
  repeatCursor = false;
  searchFails = true;
  const searchError = await run(plan("correct"));
  assert.equal(searchError.code, 1);
  assert.match(JSON.parse(searchError.stdout)[0].error, /查重失败/);
  assert.ok(!readFileSync(trace, "utf8").includes('"method":"PUT"'), "搜索失败在认领前停止");
  searchFails = false;
  historicalSettled = false;
  const live = await run(plan("correct"));
  assert.equal(live.code, 1);
  assert.equal(JSON.parse(live.stdout)[0].duplicate.threadId, "historical");
  assert.ok(!readFileSync(trace, "utf8").includes('"method":"PUT"'), "未结命中须复核范围，暂不认领");
  historicalSettled = true;
  failOnceSecond = true;
  const batchPlan = plan("correct");
  batchPlan.launches.push({ ...batchPlan.launches[0] });
  const retry = await run(batchPlan);
  assert.equal(retry.code, 1, "保留首项错误，后项仍能重读完整目录并执行");
  const retried = JSON.parse(retry.stdout);
  assert.match(retried[0].error, /清单读取失败/);
  assert.deepEqual(retried[0].claimed, []);
  assert.equal(retried[1].threadId, "launched", "读取失败不得在同批中形成负缓存");
  assert.equal(readFileSync(trace, "utf8").split('\n').filter((line) => line.includes('"method":"PUT"')).length, 1);
  const issue = JSON.parse(readFileSync(issueFile, "utf8"));
  issue.internal_meta.workflow_status = "";
  writeFileSync(issueFile, JSON.stringify(issue));
  calls.length = 0;
  const good = await run(plan("correct"));
  assert.equal(good.code, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout)[0].threadId, "launched", "已结束的共识线程不阻止派出");
  assert.ok(calls.some((c) => c.name === "t3_thread_read" && c.a.threadId === "historical" && c.a.environmentId === "local"));
  assert.ok(calls.some((c) => c.name === "t3_project_list" && c.a.cursor === 100));
  assert.ok(readFileSync(trace, "utf8").includes('"method":"PUT"'));
  const results = join(dir, "launched.json");
  writeFileSync(results, good.stdout);
  const readback = await exec(process.execPath, [fileURLToPath(new URL("../../t3-patrol/scripts/patrol-evidence.mjs", import.meta.url)), "--from", results], { env, timeout: 10000 });
  assert.equal(JSON.parse(readback.stdout).threads[0].threadId, "launched");
  assert.equal(JSON.parse(readback.stdout).threads[0].environmentId, "remote");
});
