#!/usr/bin/env node
// 巡检失败恢复：按快照里的 modelLadder 批量换档、发送 M4、等待后回读 run。
// 用法：node patrol-tier.mjs --snapshot /tmp/t3-patrol-snapshot.json --to fallback [--evidence <取证.json>] [--dry-run] [--skip <id|link|title>]
// 依赖 T3 注入的 MCP 会话（与 patrol-snapshot.mjs 相同）。

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { threadInputs } from "./patrol-evidence.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const SNAPSHOT = opt("snapshot", "/tmp/t3-patrol-snapshot.json");
const TO = opt("to", "fallback");
const EVIDENCE = opt("evidence", null);
const DRY_RUN = has("dry-run");
const INCLUDE_CANCELLED = has("include-cancelled");
const SKIP = new Set(args.flatMap((x, i) => (x === "--skip" && args[i + 1] ? args[i + 1].split(",") : [])).map((x) => x.trim()).filter(Boolean));
const DELAY_MS = Number(opt("delay-ms", 0));

// T3 把 MCP 会话注入 harness 进程环境：ACP 类（droid、devin）给 T3_ACP_MCP_*（authorization 已带 Bearer 前缀），
// pi 给 T3_MCP_URL / T3_MCP_BEARER_TOKEN（裸 token）。Codex 的会话只写进自身 MCP 配置，shell 里拿不到，缺席时退出码 2。
const ACP = !!(process.env.T3_ACP_MCP_ENDPOINT && process.env.T3_ACP_MCP_AUTHORIZATION);
const URL_ = ACP ? process.env.T3_ACP_MCP_ENDPOINT : process.env.T3_MCP_URL;
const AUTH = ACP ? process.env.T3_ACP_MCP_AUTHORIZATION : process.env.T3_MCP_BEARER_TOKEN && `Bearer ${process.env.T3_MCP_BEARER_TOKEN}`;
let sid = null;
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, attempt = 0) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: AUTH,
  };
  if (sid) headers["mcp-session-id"] = sid;
  let res;
  try {
    res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  } catch (e) {
    if (attempt < 1) {
      await sleep(800);
      return rpc(method, params, attempt + 1);
    }
    throw e;
  }
  sid = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  const m = text.match(/^data: (.*)$/m);
  const msg = JSON.parse(m ? m[1] : text);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? "error"}`);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

const clip = (s, n = 30) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function tierOf(ladder, to) {
  if (to === "fallback") return ladder.find((x) => x.fallback) ?? ladder.at(-1);
  const idx = Number(to);
  if (Number.isInteger(idx) && idx >= 1 && idx <= ladder.length) return ladder[idx - 1];
  return ladder.find((x) => x.name === to || `${x.instanceId}/${x.model}` === to || x.model === to);
}

function recoveryPoint(t) {
  const pr = (t.prs ?? t.pullRequests ?? []).map((x) => String(x).match(/(?:#|\/pulls?\/|^)(\d+)(?=\D|$)/)?.[1]).find(Boolean);
  if (pr) return `处理 PR #${pr} 的最新状态`;
  const task = clip(t.task || t.title, 36);
  return task || "你被中断的工作";
}

async function main() {
  if (has("evidence") && (!EVIDENCE || EVIDENCE.startsWith("--"))) throw new Error("--evidence 缺少文件路径");
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const ladder = snap.modelLadder ?? [];
  const tier = tierOf(ladder, TO);
  if (!tier) throw new Error(`找不到目标档位：${TO}`);
  const jobs = [];
  const skipped = [];
  const unresolved = [];
  const sources = EVIDENCE
    ? [{ failedThreads: threadInputs(JSON.parse(readFileSync(EVIDENCE, "utf8")), "failed") }]
    : snap.environments ?? [];
  for (const env of sources) {
    for (const t of env.failedThreads ?? []) {
      if (t.error) {
        unresolved.push({ environmentId: t.environmentId ?? env.environmentId, threadId: t.id, error: t.error });
        continue;
      }
      if (!["failed", "interrupted", "cancelled"].includes(t.status)) continue;
      const job = { environmentId: env.environmentId, label: env.label, ...t };
      if (SKIP.has(t.id) || SKIP.has(t.link) || SKIP.has(t.title)) {
        skipped.push(job);
        continue;
      }
      if (t.status === "cancelled" && !INCLUDE_CANCELLED) {
        skipped.push({ ...job, reason: "cancelled" });
        continue;
      }
      jobs.push(job);
    }
  }
  const plan = jobs.map((t) => ({ environmentId: t.environmentId, threadId: t.id, title: t.title, status: t.status, from: t.model, to: `${tier.instanceId}/${tier.model}` }));
  if (DRY_RUN || !jobs.length) {
    console.log(JSON.stringify({ to: tier.name ?? `${tier.instanceId}/${tier.model}`, count: plan.length, skipped: skipped.map((t) => ({ threadId: t.id, title: t.title, status: t.status, reason: t.reason ?? "skip" })), unresolved, ...(DRY_RUN ? { plan } : { sent: [], errors: [] }) }, null, 2));
    if (unresolved.length) process.exitCode = 1;
    return;
  }
  if (!URL_ || !AUTH) {
    console.error("缺少 T3 MCP 会话（T3_ACP_MCP_* 或 T3_MCP_URL / T3_MCP_BEARER_TOKEN，当前 harness 未向 shell 注入）：改用 MCP 工具按技能步骤手工取证。");
    process.exit(2);
  }

  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t3-patrol", version: "1" } });
  const sent = [];
  const errors = [];
  for (const t of jobs) {
    const scope = { ...(t.environmentId ? { environmentId: t.environmentId } : {}), threadId: t.id };
    let stage = "refresh";
    try {
      const before = await call("t3_thread_read", { ...scope, limit: 1, maxCharsPerItem: 10 });
      if (before.thread.activeRunId || !["failed", "interrupted", ...(INCLUDE_CANCELLED ? ["cancelled"] : [])].includes(before.thread.status)) {
        skipped.push({ ...scope, reason: "状态已变化，保留并重新判定", status: before.thread.status });
        continue;
      }
      stage = "configure";
      const modelSelection = { instanceId: tier.instanceId, model: tier.model, options: tier.options };
      await call("t3_thread_configure", { ...scope, modelSelection });
      stage = "send";
      const message = `【巡检】已切换模型到 ${tier.name ?? `${tier.instanceId}/${tier.model}`}，继续：${recoveryPoint(t)}`;
      const r = await call("t3_thread_send", { ...scope, message, mode: "auto" });
      sent.push({ ...scope, title: t.title, runId: r.runId, status: r.status, delivery: r.delivery });
    } catch (e) {
      errors.push({ ...scope, stage, configured: stage === "send", error: String(e.message ?? e) });
    }
  }

  if (DELAY_MS > 0 && sent.length) await sleep(DELAY_MS);
  for (const t of sent) {
    try {
      const r = await call("t3_thread_read", { ...(t.environmentId ? { environmentId: t.environmentId } : {}), threadId: t.threadId, limit: 1, maxCharsPerItem: 10 });
      const latest = (r.recentRuns ?? []).find((x) => x.runId === t.runId);
      t.verify = latest ? `${latest.status}@${latest.completedAt ?? latest.startedAt ?? latest.requestedAt}` : "no-run";
    } catch (e) {
      t.verify = `read-failed:${e.message}`;
    }
  }
  console.log(JSON.stringify({ to: tier.name ?? `${tier.instanceId}/${tier.model}`, count: sent.length, skipped, sent, errors, unresolved }, null, 2));
  if (errors.length || unresolved.length) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
