#!/usr/bin/env node
// 跨环境活跃线程扫描：经 T3 MCP 的 HTTP 端点收集本机与所有已连接环境里，窗口期内真正有活动的线程，
// 并从工具调用里提取读取过的 SKILL.md、`$技能名` 提及与用户消息，供复盘使用。
//
// 用法：node t3-activity-scan.mjs [--hours 24] [--self <本线程 id>] [--concurrency 6] > scan.json
// 依赖 T3 向 harness 进程注入的 MCP 会话（ACP 类与 pi 有，Codex 没有；缺席时退出码 2）。
//
// 「活跃」按最近一次 run 的时间或创建时间判断，不看 t3_thread_list 的 updatedAt：
// 同步会批量刷新 updatedAt，用它筛会把几百个老线程误算进窗口。

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const HOURS = Number(opt("hours", 24));
const SELF = opt("self", null);
const CONC = Number(opt("concurrency", 6));
// T3 把 MCP 会话注入 harness 进程环境：ACP 类（droid、devin）给 T3_ACP_MCP_*（authorization 已带 Bearer 前缀），
// pi 给 T3_MCP_URL / T3_MCP_BEARER_TOKEN（裸 token）。Codex 的会话只写进自身 MCP 配置，shell 里拿不到，缺席时退出码 2。
const ACP = !!(process.env.T3_ACP_MCP_ENDPOINT && process.env.T3_ACP_MCP_AUTHORIZATION);
const URL_ = ACP ? process.env.T3_ACP_MCP_ENDPOINT : process.env.T3_MCP_URL;
const AUTH = ACP ? process.env.T3_ACP_MCP_AUTHORIZATION : process.env.T3_MCP_BEARER_TOKEN && `Bearer ${process.env.T3_MCP_BEARER_TOKEN}`;

let sid = null;
let seq = 0;
async function rpc(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: AUTH };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  sid = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  const m = text.match(/^data: (.*)$/m);
  const msg = JSON.parse(m ? m[1] : text);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
async function call(name, a) {
  const r = await rpc("tools/call", { name, arguments: a });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? "error"}`);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}
async function pool(items, fn) {
  const q = [...items];
  const out = [];
  await Promise.all(Array.from({ length: CONC }, async () => { while (q.length) out.push(await fn(q.shift())); }));
  return out;
}
const flat = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function listCandidates(env, since) {
  const out = [];
  for (let cursor = 0; ;) {
    const p = await call("t3_thread_list", { allProjects: true, includeSubagents: true, limit: 100, cursor, ...env.arg });
    out.push(...p.threads);
    const oldest = p.threads.at(-1);
    if (p.nextCursor == null || (oldest && Date.parse(oldest.updatedAt) < since)) return out.filter((t) => Date.parse(t.updatedAt) >= since);
    cursor = p.nextCursor;
  }
}

async function scanThread(env, t, since) {
  const rec = { id: t.threadId, link: t.link, title: flat(t.title, 80), parent: t.parentThreadId ?? null, model: t.model, prs: (t.pullRequests ?? []).map((p) => `${p.repository}#${p.number}:${p.state}`) };
  const head = await call("t3_thread_read", { threadId: t.threadId, limit: 1, maxCharsPerItem: 400, ...env.arg });
  const runs = head.recentRuns ?? [];
  const lastRun = Math.max(0, ...runs.map((r) => Date.parse(r.completedAt ?? r.startedAt ?? r.requestedAt) || 0));
  if (lastRun < since && Date.parse(head.thread.createdAt) < since) return null;
  Object.assign(rec, { status: head.thread.status, lastRun: new Date(lastRun).toISOString(), task: flat(head.items[0]?.text, 300), skillReads: [], mentions: {}, users: [] });
  // 从尾部按块往回翻 activity，翻到窗口起点为止。
  const reads = new Set();
  for (let end = (t.itemCount ?? 0) + 5, stop = false; end > 0 && !stop;) {
    const after = Math.max(0, end - 150);
    const items = [];
    for (let pos = after, g = 0; g < 10; g++) {
      const r = await call("t3_thread_read", { threadId: t.threadId, view: "activity", afterPosition: pos, limit: 100, maxCharsPerItem: 400, ...env.arg });
      items.push(...r.items);
      if (!r.hasMore || r.nextPosition == null || r.nextPosition >= end) break;
      pos = r.nextPosition;
    }
    for (const i of items) {
      if (i.position >= end || i.position <= after) continue;
      if (Date.parse(i.updatedAt) < since) { stop = true; continue; }
      const tx = `${i.text ?? ""} ${i.title ?? ""}`;
      if (i.type === "dynamic_tool" || i.type === "command_execution") for (const m of tx.matchAll(/skills[\\/]+([\w-]+)[\\/]+SKILL\.md/g)) reads.add(m[1]);
      for (const m of tx.matchAll(/\$([a-z][\w-]+)/g)) rec.mentions[m[1]] = (rec.mentions[m[1]] ?? 0) + 1;
      if (i.type === "user_message") rec.users.push({ p: i.position, by: i.createdBy, at: i.updatedAt?.slice(5, 16), text: flat(tx, 400) });
    }
    if (after === 0) break;
    end = after + 1;
  }
  rec.skillReads = [...reads];
  rec.users.sort((a, b) => a.p - b.p);
  return rec;
}

async function main() {
  if (!URL_ || !AUTH) {
    console.error("缺少 T3 MCP 会话（T3_ACP_MCP_* 或 T3_MCP_URL / T3_MCP_BEARER_TOKEN，当前 harness 未向 shell 注入）：改用 t3_thread_list / t3_thread_read 手工取证。");
    process.exit(2);
  }
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t3-activity-scan", version: "1" } });
  const since = Date.now() - HOURS * 3600e3;
  const links = await call("t3_environment_links", {});
  const envs = [{ environmentId: links.environmentId, label: "本机", arg: {} }];
  const unreachable = [];
  for (const l of links.links ?? []) {
    if (l.status === "reachable") envs.push({ environmentId: l.environmentId, label: l.label, arg: { environmentId: l.environmentId } });
    else unreachable.push({ environmentId: l.environmentId, label: l.label, status: l.status, error: l.lastError });
  }
  const environments = [];
  for (const env of envs) {
    try {
      const cands = (await listCandidates(env, since)).filter((t) => t.threadId !== SELF);
      const threads = (await pool(cands, (t) => scanThread(env, t, since).catch((e) => ({ id: t.threadId, link: t.link, error: String(e.message ?? e) })))).filter(Boolean);
      environments.push({ environmentId: env.environmentId, label: env.label, threads });
    } catch (e) {
      environments.push({ environmentId: env.environmentId, label: env.label, error: String(e.message ?? e) });
    }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), hours: HOURS, unreachable, environments }, null, 1));
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
