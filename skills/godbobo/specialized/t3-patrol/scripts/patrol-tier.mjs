#!/usr/bin/env node
// 巡检失败恢复：按快照里的 modelLadder 批量换档、发送 M4、等待后回读 run。
// 用法：node patrol-tier.mjs --snapshot /tmp/t3-patrol-snapshot.json --to fallback [--dry-run] [--skip <id|link|title>]
// 依赖 T3_MCP_URL、T3_MCP_BEARER_TOKEN（与 patrol-snapshot.mjs 相同）。

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const SNAPSHOT = opt("snapshot", "/tmp/t3-patrol-snapshot.json");
const TO = opt("to", "fallback");
const DRY_RUN = has("dry-run");
const INCLUDE_CANCELLED = has("include-cancelled");
const SKIP = new Set(args.flatMap((x, i) => (x === "--skip" && args[i + 1] ? args[i + 1].split(",") : [])).map((x) => x.trim()).filter(Boolean));
const DELAY_MS = Number(opt("delay-ms", 120000));

const URL_ = process.env.T3_MCP_URL;
const TOKEN = process.env.T3_MCP_BEARER_TOKEN;
let sid = null;
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, attempt = 0) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
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
  const pr = (t.prs ?? []).map((x) => String(x).match(/#(\d+)/)?.[1]).find(Boolean);
  if (pr) return `处理 PR #${pr} 的最新状态`;
  const task = clip(t.task || t.title, 36);
  return task ? `继续：${task}` : "继续你被中断的工作";
}

async function main() {
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const ladder = snap.modelLadder ?? [];
  const tier = tierOf(ladder, TO);
  if (!tier) throw new Error(`找不到目标档位：${TO}`);
  const jobs = [];
  const skipped = [];
  for (const env of snap.environments ?? []) {
    for (const t of env.failedThreads ?? []) {
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
  if (DRY_RUN) {
    console.log(JSON.stringify({ to: tier.name ?? `${tier.instanceId}/${tier.model}`, count: plan.length, skipped: skipped.map((t) => ({ threadId: t.id, title: t.title, status: t.status, reason: t.reason ?? "skip" })), plan }, null, 2));
    return;
  }
  if (!URL_ || !TOKEN) {
    console.error("缺少 T3_MCP_URL / T3_MCP_BEARER_TOKEN：改用 MCP 工具按技能步骤手工取证。");
    process.exit(2);
  }

  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t3-patrol", version: "1" } });
  const sent = [];
  for (const t of jobs) {
    const modelSelection = { instanceId: tier.instanceId, model: tier.model, options: tier.options };
    await call("t3_thread_configure", { environmentId: t.environmentId, threadId: t.id, modelSelection });
    const message = `【巡检】已切换模型到 ${tier.name ?? `${tier.instanceId}/${tier.model}`}，继续：${recoveryPoint(t)}`;
    const r = await call("t3_thread_send", { environmentId: t.environmentId, threadId: t.id, message, mode: "auto" });
    sent.push({ environmentId: t.environmentId, threadId: t.id, title: t.title, runId: r.runId, status: r.status, delivery: r.delivery });
  }

  if (DELAY_MS > 0 && sent.length) await sleep(DELAY_MS);
  for (const t of sent) {
    try {
      const r = await call("t3_thread_read", { environmentId: t.environmentId, threadId: t.threadId, limit: 1, maxCharsPerItem: 10 });
      const latest = (r.recentRuns ?? []).find((x) => x.runId === t.runId) ?? r.recentRuns?.[0];
      t.verify = latest ? `${latest.status}@${latest.completedAt ?? latest.startedAt ?? latest.requestedAt}` : "no-run";
    } catch (e) {
      t.verify = `read-failed:${e.message}`;
    }
  }
  console.log(JSON.stringify({ to: tier.name ?? `${tier.instanceId}/${tier.model}`, count: sent.length, sent }, null, 2));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
