import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyPatch, MAX_PER_REPO, poolPath, readPool, removeIds, validateCandidate } from "./candidate-pool.mjs";

const REPO = "host/owner/app";
const NOW = Date.parse("2026-11-14T10:00:00Z");
const entry = (id = "a", extra = {}) => ({
  id, ref: `INT-${id}`, title: "修复已复现的错误", state: "ready", deferredBy: "capacity",
  scope: "客户端错误处理", reason: "已复现，仅缺空位", nextCheck: "复核问题状态、依赖和相关路径差异",
  checkedAt: new Date(NOW).toISOString(), issueUpdatedAt: "2026-11-13T10:00:00Z",
  devices: ["pc"], source: { head: "abc", paths: ["src/client"] }, evidenceRefs: ["issue:INT-a"], ...extra,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-pool-"));
  const env = { ...process.env, BSTACK_CONFIG_DIR: dir };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return env;
}

test("缺省只读；补丁按项目合并、移除且原子落盘", (t) => {
  const env = fixture(t);
  const initial = readPool(env);
  assert.equal(existsSync(poolPath(env)), false);
  const a = applyPatch({ repo: REPO, env, patch: { revision: initial.revision, upsert: [entry()], remove: [] } });
  const b = applyPatch({ repo: "host/owner/other", env, patch: { revision: a.revision, upsert: [entry("b")], remove: [] } });
  const c = applyPatch({ repo: REPO, env, patch: { revision: b.revision, upsert: [entry("c")], remove: ["a"] } });
  assert.deepEqual(c.state.repos[REPO].map((e) => e.id), ["c"]);
  assert.equal(c.state.repos["host/owner/other"][0].id, "b");
  assert.equal(existsSync(`${poolPath(env)}.lock`), false);
});

test("陈旧 revision、并发写锁、重复 ID 与超限均保留原池", (t) => {
  const env = fixture(t);
  const first = readPool(env);
  const saved = applyPatch({ repo: REPO, env, patch: { revision: first.revision, upsert: [entry()], remove: [] } });
  const original = readFileSync(poolPath(env), "utf8");
  const apply = (patch) => applyPatch({ repo: REPO, env, patch: { revision: saved.revision, upsert: [], remove: [], ...patch } });
  assert.throws(() => apply({ revision: first.revision }), /已变化/);
  assert.throws(() => apply({ upsert: [entry(), entry()] }), /重复/);
  assert.throws(() => apply({ upsert: [entry()], remove: ["a"] }), /冲突/);
  assert.throws(() => apply({ upsert: Array.from({ length: MAX_PER_REPO + 1 }, (_, i) => entry(String(i))) }), /最多/);
  writeFileSync(`${poolPath(env)}.lock`, "busy");
  assert.throws(() => apply({}), (e) => e.message.includes(`${poolPath(env)}.lock`) && /写锁已存在/.test(e.message) && /不自动删除或轮询重试/.test(e.message) && /维护阻塞/.test(e.message));
  assert.equal(readFileSync(`${poolPath(env)}.lock`, "utf8"), "busy", "不能自动拆除未知归属的锁");
  assert.equal(readFileSync(poolPath(env), "utf8"), original);
});

test("池损坏不静默覆盖；必需依据与状态一致性校验", (t) => {
  const env = fixture(t);
  mkdirSync(dirname(poolPath(env)), { recursive: true });
  writeFileSync(poolPath(env), "broken");
  assert.throws(() => readPool(env));
  assert.throws(() => applyPatch({ repo: REPO, env, patch: { revision: "x", upsert: [], remove: [] } }));
  assert.equal(readFileSync(poolPath(env), "utf8"), "broken");
  for (const extra of [{ state: "blocked" }, { state: "pending" }, { issueUpdatedAt: undefined }, { devices: [] }, { evidenceRefs: [] }, { source: {} }]) {
    assert.throws(() => validateCandidate(entry("a", extra)));
  }
  assert.doesNotThrow(() => validateCandidate(entry("a", { state: "blocked", deferredBy: "dependency" })));
  assert.doesNotThrow(() => validateCandidate(entry("a", { state: "pending", deferredBy: "evidence", issueUpdatedAt: null })));
});

test("未知源码显式为 null，仅未就绪条目可落盘和离线预检", (t) => {
  const env = fixture(t);
  const pending = entry("unknown", { state: "pending", deferredBy: "evidence", source: null, nextCheck: "定位实现路径并核最新目标 HEAD" });
  const blocked = entry("blocked", { state: "blocked", deferredBy: "dependency", source: null });
  assert.throws(() => validateCandidate(entry("bad", { source: null })), /ready 须带/);
  const patch = { upsert: [pending, blocked], remove: [] };
  const file = join(env.BSTACK_CONFIG_DIR, "suggestions.json");
  writeFileSync(file, JSON.stringify(patch));
  const script = fileURLToPath(new URL("./candidate-pool.mjs", import.meta.url));
  const call = () => spawnSync(process.execPath, [script, "validate", "--file", file], { env, encoding: "utf8" });
  assert.equal(call().status, 0);
  assert.equal(existsSync(poolPath(env)), false, "预检不创建共享池");
  const saved = applyPatch({ repo: REPO, env, patch: { ...patch, revision: readPool(env).revision } });
  assert.equal(saved.state.repos[REPO][0].source, null);
  writeFileSync(file, JSON.stringify({ upsert: [entry("bad", { source: null })], remove: [] }));
  assert.equal(call().status, 1);
});

test("真实补货 CLI：库存里的题不再研判，只读元数据，不写共享状态；池损坏照常补货", (t) => {
  const base = fixture(t);
  const dir = base.BSTACK_CONFIG_DIR;
  const api = join(dir, "fake-api.mjs");
  const trace = join(dir, "requests.jsonl");
  const dataFile = join(dir, "issues.json");
  writeFileSync(api, `import fs from 'node:fs';
const [method,path] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({method,path})+'\\n');
if(method !== 'GET') throw new Error('只允许读取');
const issues=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)},'utf8'));
const data=path.startsWith('/api/projects/p/issues?') ? {items:issues} : issues.find(i=>path==='/api/issues/'+i.id);
if(!data) throw new Error('未模拟的查询 '+path);
console.log(JSON.stringify({code:0,data}));`);
  const issues = ["a", "b"].map((id) => ({ id, reference: `INT-${id}`, title: id === "b" ? "启动崩溃" : "功能错误",
    state: "open", source: "internal", updated_at: entry().issueUpdatedAt, body: "完整正文",
    internal_meta: { labels: id === "b" ? [{ name: "bstack:priority" }] : [] },
  }));
  writeFileSync(dataFile, JSON.stringify(issues));
  writeFileSync(join(dir, "t3-dispatch.json"), JSON.stringify({ mode: "dry-run", repos: [{ repo: REPO, source: "fast-ship", project: "p", statuses: ["unset"] }] }));
  writeFileSync(join(dir, "environments.json"), JSON.stringify({ environments: { pc: { environmentId: "e", device: "pc", os: "windows" } } }));
  const cap = join(dir, "capacity.json");
  writeFileSync(cap, JSON.stringify({ environments: [{ environmentId: "e", projects: [{ id: "p", canonicalKey: REPO }], capacity: { freeByRepo: { [REPO]: 1 }, poolByRepo: { [REPO]: "general" }, pools: [{ name: "general", max: 1 }] }, openThreads: [] }] }));
  applyPatch({ repo: REPO, env: base, patch: { revision: readPool(base).revision, upsert: [entry("a", { checkedAt: new Date().toISOString() })], remove: [] } });
  const before = readFileSync(poolPath(base), "utf8");
  // 不继承任何真实 MCP 会话或凭据，所有 API 请求只进本测试脚本。
  const env = { PATH: process.env.PATH, HOME: dir, BSTACK_CONFIG_DIR: dir, FAST_SHIP_API: api };
  const call = () => spawnSync(process.execPath, [fileURLToPath(new URL("./dispatch-plan.mjs", import.meta.url)), "--capacity", cap], { env, encoding: "utf8" });
  let result = call();
  assert.equal(result.status, 0, result.stderr);
  let plan = JSON.parse(result.stdout);
  assert.deepEqual([plan.refill[0].target, plan.refill[0].stock, plan.refill[0].deficit], [3, 1, 2]);
  assert.deepEqual(plan.repos[0].shortlist.map((c) => c.id), ["b"]);
  assert.ok(!readFileSync(trace, "utf8").includes("/api/issues/"), "补货清单只读元数据，正文留给补货子代理");
  assert.equal(readFileSync(poolPath(base), "utf8"), before);
  assert.equal(existsSync(join(dir, "state", "t3-dispatch.jsonl")), false);
  applyPatch({ repo: REPO, env: base, patch: { revision: readPool(base).revision, upsert: [entry("a", { state: "pending", deferredBy: "evidence", source: null })], remove: [] } });
  plan = JSON.parse(call().stdout);
  assert.equal(plan.repos[0].shortlist.find((c) => c.id === "a").pooled.state, "pending");
  writeFileSync(poolPath(base), "broken");
  result = call();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).warnings.some((w) => w.includes("候选池读取失败")));
  assert.equal(readFileSync(poolPath(base), "utf8"), "broken");
});

test("removeIds 只删存在的条目，保留顺序与其他仓库", (t) => {
  const env = fixture(t);
  applyPatch({ repo: REPO, env, patch: { revision: readPool(env).revision, upsert: [entry("a"), entry("b"), entry("c")], remove: [] } });
  assert.deepEqual(removeIds({ repo: REPO, env, ids: ["b", "x"] }).removed, ["b"]);
  assert.deepEqual(readPool(env).state.repos[REPO].map((e) => e.id), ["a", "c"]);
  assert.deepEqual(removeIds({ repo: REPO, env, ids: ["x"] }).removed, []);
});

test("CLI 使用隔离配置目录，list 不写文件；apply 错误非零退出", (t) => {
  const env = fixture(t);
  const script = fileURLToPath(new URL("./candidate-pool.mjs", import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  const r = call("list", "--repo", REPO);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).state.repos[REPO], []);
  assert.equal(existsSync(poolPath(env)), false);
  const file = join(env.BSTACK_CONFIG_DIR, "patch.json");
  writeFileSync(file, JSON.stringify({ revision: JSON.parse(r.stdout).revision, upsert: [entry()], remove: [] }));
  const applied = call("apply", "--repo", REPO, "--file", file);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(call("apply", "--repo", REPO, "--file", file).status, 1);
});
