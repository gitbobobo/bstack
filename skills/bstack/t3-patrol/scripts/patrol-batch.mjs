#!/usr/bin/env node
// 巡检批量写操作：一条命令执行多条 T3 MCP 调用并回读，取代每轮现写的动作脚本。
//
// 用法：
//   node patrol-batch.mjs --watch <快照>      给快照里全部 needsWatchThreads 代挂监听（PR 已合并/关闭的跳过），再回读 watching
//   node patrol-batch.mjs --calls <文件>      按文件逐条执行任意 MCP 调用（发消息、改名、settle、interrupt……）
// 两者可同时给。calls 文件（UTF-8 JSON，消息正文写在里面，不进命令行）：
//   [ { "label": "M10 #28", "tool": "t3_thread_send", "args": { "environmentId": "…", "threadId": "…", "mode": "auto", "message": "【巡检】…" } }, … ]
// 输出 { watch: [{ threadId, environmentId, url, result|skipped|error, watching }], calls: [{ label, tool, ok, result|error }] }；
// result 只留判定字段（messageId、runId、threadId、status、title 等），有失败时退出码 1。
// 只负责执行与即时返回值；预期动作有没有发生（目标线程是否接手）仍用 patrol-evidence.mjs 回读对应 run。

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { call, connect, hasSession, NO_SESSION } from "./t3-mcp.mjs";

const KEEP = ["messageId", "runId", "threadId", "link", "status", "title", "settled", "watching", "queuedRunId", "delivery", "url", "state"];
export function brief(v) {
  if (v == null || typeof v !== "object") return v;
  const out = Object.fromEntries(KEEP.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
  if (v.thread && typeof v.thread === "object") Object.assign(out, brief(v.thread));
  return Object.keys(out).length ? out : JSON.stringify(v).slice(0, 300);
}

async function watchAll(snapshotFile) {
  const snap = JSON.parse(readFileSync(snapshotFile, "utf8"));
  const out = [];
  for (const env of snap.environments ?? []) {
    for (const t of env.needsWatchThreads ?? []) {
      const scope = { environmentId: env.environmentId, threadId: t.id };
      const before = await call("list_thread_pull_requests", scope).catch(() => null);
      for (const url of t.urls ?? []) {
        const pr = before?.pullRequests?.find((p) => p.url === url);
        if (pr && pr.state !== "open") {
          out.push({ ...scope, url, skipped: `PR 已 ${pr.state}` });
          continue;
        }
        try {
          out.push({ ...scope, url, result: brief(await call("watch_pull_request", { ...scope, url })) });
        } catch (e) {
          out.push({ ...scope, url, error: String(e.message ?? e) });
        }
      }
      const after = await call("list_thread_pull_requests", scope).catch(() => null);
      for (const w of out.filter((x) => x.threadId === t.id && !x.skipped)) w.watching = after?.pullRequests?.find((p) => p.url === w.url)?.watching ?? null;
    }
  }
  return out;
}

async function runCalls(file) {
  const list = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(list)) throw new Error("calls 文件须是数组");
  const out = [];
  for (const [i, c] of list.entries()) {
    const label = c.label ?? `#${i}`;
    if (typeof c.tool !== "string" || typeof c.args !== "object") {
      out.push({ label, ok: false, error: "缺 tool 或 args" });
      continue;
    }
    try {
      out.push({ label, tool: c.tool, ok: true, result: brief(await call(c.tool, c.args)) });
    } catch (e) {
      out.push({ label, tool: c.tool, ok: false, error: String(e.message ?? e) });
    }
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const watchFile = opt("watch");
  const callsFile = opt("calls");
  if (!watchFile && !callsFile) {
    console.error("用法：node patrol-batch.mjs [--watch <快照>] [--calls <文件>]");
    process.exit(2);
  }
  if (!hasSession()) {
    console.error(NO_SESSION);
    process.exit(2);
  }
  try {
    await connect("t3-patrol-batch");
    const out = {};
    if (watchFile) out.watch = await watchAll(watchFile);
    if (callsFile) out.calls = await runCalls(callsFile);
    console.log(JSON.stringify(out, null, 1));
    process.exit((out.watch ?? []).some((w) => w.error) || (out.calls ?? []).some((c) => !c.ok) ? 1 : 0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
