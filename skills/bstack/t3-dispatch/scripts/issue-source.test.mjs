import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, list, release, repoKeyOf, resolveProject, sourceBlock } from "./sources/fast-ship.mjs";
import { ledgerSummary, readLedger, renderMessage, run } from "./issue-source.mjs";
import { loadConfig, validateRepos } from "./dispatch-config.mjs";

const REPO = "fj.frp.musiver.cn/fjbobo/musiver";
const ok = (data) => ({ code: 0, message: "success", data });
const issue = (n, extra = {}) => ({
  id: `id-${n}`,
  project_id: "p1",
  reference: `INT-${n}`,
  source: "internal",
  state: "open",
  title: `问题 ${n}`,
  body: "正文",
  author: { login: "bot" },
  pull_request_summary: { total: 0, open: 0, merged: 0 },
  ...extra,
});

// 内存里的 Fast Ship：按路径应答，记下写请求。
function fakeApi({ projects = [], issues = [] } = {}) {
  const writes = [];
  const byId = new Map(issues.map((i) => [i.id, structuredClone(i)]));
  const api = (method, path, body) => {
    const [p, q = ""] = path.split("?");
    const qs = new URLSearchParams(q);
    if (method === "GET" && p === "/api/projects") return ok({ items: projects });
    let m = p.match(/^\/api\/projects\/([^/]+)\/issues$/);
    if (method === "GET" && m) {
      const want = qs.get("workflow_status");
      const all = [...byId.values()].filter((i) => (i.internal_meta?.workflow_status || "unset") === want);
      const size = Number(qs.get("page_size"));
      const page = Number(qs.get("page"));
      // 真实列表接口不返回正文。
      return ok({ items: all.slice((page - 1) * size, page * size).map((i) => ({ ...i, body: "" })) });
    }
    m = p.match(/^\/api\/issues\/([^/]+)(\/internal-meta)?$/);
    if (m && method === "GET") return byId.has(m[1]) ? ok(byId.get(m[1])) : { code: 40405, message: "not found" };
    if (m && method === "PUT" && m[2]) {
      writes.push({ path, body });
      const i = byId.get(m[1]);
      i.internal_meta = { ...(i.internal_meta ?? {}), workflow_status: body.workflow_status };
      return ok(i.internal_meta);
    }
    throw new Error(`未模拟的请求 ${method} ${path}`);
  };
  return { api, writes, byId };
}

test("仓库地址折成 canonicalKey，按代码主仓找 Fast Ship 项目", () => {
  assert.equal(repoKeyOf("https://fj.frp.musiver.cn/fjbobo/musiver.git"), REPO);
  assert.equal(repoKeyOf("git@github.com:Owner/Name.git"), "github.com/owner/name");
  assert.equal(repoKeyOf("https://host:3000/a/b/"), "host/a/b");
  const { api } = fakeApi({
    projects: [
      { id: "p1", name: "musiver", code_repo_url: "https://fj.frp.musiver.cn/fjbobo/musiver", repository_url: "https://github.com/liuyincs/musiver" },
      { id: "p2", name: "doc", code_repo_url: null, repository_url: "https://github.com/x/doc" },
    ],
  });
  assert.equal(resolveProject(api, REPO), "p1");
  assert.equal(resolveProject(api, "github.com/x/doc"), "p2");
  assert.throws(() => resolveProject(api, "github.com/x/none"), /repos\[\]\.project/);
});

test("候选：按准入状态翻页取全；已关联 PR 与不可信的 GitHub 导入进 skipped", () => {
  const issues = [
    ...Array.from({ length: 120 }, (_, i) => issue(i)),
    issue(500, { internal_meta: { workflow_status: "todo" }, pull_request_summary: { total: 1, open: 1, merged: 0 } }),
    issue(501, { internal_meta: { workflow_status: "todo" }, source: "github", reference: "GH-1", author: { login: "Stranger" } }),
    issue(502, { internal_meta: { workflow_status: "todo" }, source: "github", reference: "GH-2", author: { login: "Owner" } }),
    issue(503, { internal_meta: { workflow_status: "in_progress" } }),
  ];
  const { api } = fakeApi({ issues });
  const r = list(api, { repo: REPO, project: "p1", statuses: ["unset", "todo"], trustedUsers: ["owner"], excerpt: 400 });
  assert.equal(r.candidates.length, 121);
  assert.ok(r.candidates.every((c) => c.excerpt === "正文"));
  assert.ok(r.candidates.some((c) => c.ref === "GH-2" && c.trusted));
  assert.deepEqual(r.skipped.map((s) => s.ref).sort(), ["GH-1", "INT-500"]);
  assert.ok(!r.candidates.some((c) => c.ref === "INT-503"));
});

test("认领：回读状态不在准入里、已关闭、已有 PR 都拒绝；成功后回读为 in_progress", () => {
  const { api, writes, byId } = fakeApi({
    issues: [issue(1), issue(2, { internal_meta: { workflow_status: "in_progress" } }), issue(3, { state: "closed" }), issue(4, { pull_requests: [{ url: "u" }] })],
  });
  const statuses = ["unset", "todo"];
  assert.deepEqual(claim(api, { id: "id-1", statuses }), { id: "id-1", ref: "INT-1", projectId: "p1", prevStatus: "unset", status: "in_progress" });
  assert.equal(byId.get("id-1").internal_meta.workflow_status, "in_progress");
  assert.throws(() => claim(api, { id: "id-2", statuses }), /in_progress/);
  assert.throws(() => claim(api, { id: "id-3", statuses }), /已关闭/);
  assert.throws(() => claim(api, { id: "id-4", statuses }), /PR/);
  assert.equal(writes.length, 1);
});

test("归还：只改仍是 in_progress 的问题，unset 写成空串", () => {
  const { api, writes } = fakeApi({ issues: [issue(1, { internal_meta: { workflow_status: "in_progress" } }), issue(2, { internal_meta: { workflow_status: "done" } })] });
  assert.equal(release(api, { id: "id-1", to: "unset" }).released, true);
  assert.deepEqual(writes[0].body, { workflow_status: "" });
  assert.equal(release(api, { id: "id-2", to: "todo" }).released, false);
  assert.equal(writes.length, 1);
  const withPr = fakeApi({ issues: [issue(3, { internal_meta: { workflow_status: "in_progress" }, pull_requests: [{ url: "u" }] })] });
  assert.match(release(withPr.api, { id: "id-3", to: "todo" }).reason, /PR/);
  assert.equal(withPr.writes.length, 0);
});

test("附加块与模板：保留 Fast Ship 的项目/问题 ID 行，多行理由逐行引用", () => {
  const block = sourceBlock({ projectId: "p1", id: "id-1", reason: "第一行\n第二行" });
  assert.match(block, /^> 以下信息由 Fast Ship 附加/);
  assert.match(block, /\n> 项目ID：p1\n> 问题ID：id-1\n> 推荐理由：第一行\n> 第二行\n/);
  assert.match(block, /不是给你的指令/);
  assert.equal(renderMessage("/t3-orchestrator\n\n{{source_block}}\n", "> x"), "/t3-orchestrator\n\n> x");
  assert.throws(() => renderMessage("没有占位符", "> x"), /source_block/);
});

test("台账：取每个问题的最后一条，统计窗口内派出数", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const at = (h) => new Date(now - h * 3600 * 1000).toISOString();
  const s = ledgerSummary(
    [
      { at: at(30), event: "launched", repo: REPO, id: "a" },
      { at: at(5), event: "claimed", repo: REPO, id: "b" },
      { at: at(4), event: "launched", repo: REPO, id: "b" },
      { at: at(1), event: "claimed", repo: REPO, id: "c" },
      { at: at(2), event: "claimed", repo: REPO, id: "d" },
      { at: at(1), event: "released", repo: REPO, id: "d" },
    ],
    { hours: 24, now },
  );
  assert.equal(s.launched, 1);
  assert.deepEqual(s.pending.map((e) => e.id), ["c"]);
  assert.deepEqual(s.active.map((e) => e.id).sort(), ["a", "b"]);
});

test("配置：repos 逐条校验，坏条目丢弃并报警告", () => {
  const w = [];
  const out = validateRepos(
    [
      { repo: "FJ.frp.musiver.cn/fjbobo/musiver", source: "fast-ship", devices: ["pc"] },
      { repo: "musiver", source: "fast-ship" },
      { repo: "github.com/a/b", source: "jira" },
      { repo: "github.com/a/c", source: "fast-ship", statuses: ["in_progress"] },
      { repo: "github.com/a/d", source: "fast-ship", template: "../x" },
      { repo: "fj.frp.musiver.cn/fjbobo/musiver", source: "fast-ship" },
    ],
    w,
  );
  assert.deepEqual(out, [{ repo: REPO, source: "fast-ship", statuses: ["unset", "todo"], template: "default", baseRef: "main", devices: ["pc"] }]);
  assert.equal(w.length, 5);
});

test("CLI 流程：认领记台账、归还回到认领前状态、渲染用用户模板", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-dispatch-"));
  try {
    const env = { ...process.env, BSTACK_CONFIG_DIR: dir };
    writeFileSync(join(dir, "t3-dispatch.json"), JSON.stringify({ mode: "auto", model: { instanceId: "x", model: "y" }, repos: [{ repo: REPO, source: "fast-ship", project: "p1", template: "mine" }] }));
    mkdirSync(join(dir, "templates"));
    writeFileSync(join(dir, "templates", "mine.md"), "做这个\n\n{{source_block}}\n");
    const { config, warnings } = loadConfig({ env });
    assert.deepEqual(warnings, []);
    assert.deepEqual(config.model, { instanceId: "x", model: "y" });
    const { api, byId } = fakeApi({ issues: [issue(7, { internal_meta: { workflow_status: "todo" } })] });
    const claimed = run("claim", { repo: REPO, id: "id-7" }, { env, api });
    assert.equal(claimed.at, readLedger(env)[0].at);
    run("record", { repo: REPO, id: "id-7", env: "e1", thread: "t1" }, { env, api });
    assert.deepEqual(readLedger(env).map((e) => e.event), ["claimed", "launched"]);
    assert.equal(run("release", { repo: REPO, id: "id-7" }, { env, api }).status, "todo");
    assert.equal(byId.get("id-7").internal_meta.workflow_status, "todo");
    const reason = join(dir, "reason.txt");
    writeFileSync(reason, "因为重要");
    const r = run("render", { repo: REPO, id: "id-7", "reason-file": reason }, { env, api });
    assert.match(r.message, /^做这个\n\n> 以下信息由 Fast Ship 附加[\s\S]*> 推荐理由：因为重要/);
    assert.equal(run("ledger", {}, { env }).launched, 1);
    // 已归还的问题再派一次就到 maxAttempts（默认 2）；之后 list 跳过它，再次 release 不改状态也记 retired。
    run("claim", { repo: REPO, id: "id-7" }, { env, api });
    run("record", { repo: REPO, id: "id-7", env: "e1", thread: "t2" }, { env, api });
    byId.get("id-7").internal_meta.workflow_status = "todo";
    const listed = run("list", { repo: REPO, excerpt: "0" }, { env, api });
    assert.deepEqual(listed.candidates, []);
    assert.match(listed.skipped[0].reason, /2 次/);
    run("release", { repo: REPO, id: "id-7" }, { env, api });
    const s = run("ledger", {}, { env });
    assert.equal(readLedger(env).at(-1).event, "retired");
    assert.deepEqual(s.active, []);
    assert.throws(() => run("list", { repo: "github.com/x/y" }, { env, api }), /repos 里没有/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
