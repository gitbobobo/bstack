#!/usr/bin/env node
// 巡检补读：给「有事」的线程与 PR 取判定所需的原文，一次命令批量取完，只输出判定字段。
// 取代每轮现写的 MCP 客户端与 PR 抓取脚本。
//
// 用法：
//   node patrol-evidence.mjs --thread <threadId>[@<environmentId>] ... [--items 30] [--chars 1500] [--after <position>] [--queue]
//   node patrol-evidence.mjs --pr <owner/repo#N>[@<PR URL>] ...
// 两种可以混用、各自重复。本机线程省略 @environmentId。
// 线程输出：thread（状态、工作树、分支、活跃 run、待答请求）、recentRuns（含 runId，用于发后回读对应 run）、
//   task（首条用户消息原文）、activity（尾部条目，略去 reasoning；--after 从指定 position 往后读，用于读某条消息之后的活动）。
// --queue 另给每条线程的排队项（全部分页、逐项全文）：queuedRunId、text，系统生成的 PR 状态通知标 prNotice（PR 号与 URL），
//   供故障恢复「队列恢复」逐条判定；取消仍由巡检用 t3_queue 逐项执行。
// PR 输出：快照里的判定字段，加 detail（PR 描述、最近一次 review 正文与行内意见、最近评论）。

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./patrol-config.mjs";
import { call, connect, hasSession, NO_SESSION, pool } from "./t3-mcp.mjs";
import { configure as configurePr, prDetailOf } from "./pr-live.mjs";

const clip = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…[截断，共 ${t.length} 字]` : t;
};

function parseArgs(argv) {
  const out = { threads: [], prs: [], items: 30, chars: 1500, after: null, queue: false };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--thread") out.threads.push(v), i++;
    else if (k === "--pr") out.prs.push(v), i++;
    else if (k === "--items") (out.items = Number(v)), i++;
    else if (k === "--chars") (out.chars = Number(v)), i++;
    else if (k === "--after") (out.after = Number(v)), i++;
    else if (k === "--queue") out.queue = true;
  }
  return out;
}

// threadId 本身可能含冒号（mcp:launch:…），环境用 @ 分隔。
const splitAt = (s) => {
  const i = s.lastIndexOf("@");
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, null];
};

const PR_NOTICE = /^Update on pull request #(\d+) \((\S+?)\), which T3 Code is watching for you:/;

async function queueOf(threadId, scope) {
  const out = [];
  let cursor;
  for (let guard = 0; guard < 20; guard++) {
    const q = await call("t3_queue", { threadId, action: "list", limit: 100, ...(cursor != null ? { cursor } : {}), ...scope });
    for (const i of q.items ?? []) {
      const full = await call("t3_queue", { threadId, action: "read", queuedRunId: i.queuedRunId, ...scope }).catch(() => null);
      const text = full?.text ?? i.text ?? "";
      const m = text.match(PR_NOTICE);
      out.push({ queuedRunId: i.queuedRunId, ...(m ? { prNotice: { pr: Number(m[1]), url: m[2] } } : {}), truncated: Boolean(full?.truncated), text: clip(text, 800) });
    }
    if (q.nextCursor == null) break;
    cursor = q.nextCursor;
  }
  return out;
}

async function threadEvidence(spec, { items, chars, after, queue }) {
  const [threadId, environmentId] = splitAt(spec);
  const scope = environmentId ? { environmentId } : {};
  try {
    const head = await call("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 6000, ...scope });
    const t = head.thread;
    let start = after ?? Math.max(0, (t.itemCount ?? 0) - items * 2);
    const got = [];
    for (let guard = 0; guard < 10; guard++) {
      const r = await call("t3_thread_read", { threadId, view: "activity", afterPosition: start, limit: 50, maxCharsPerItem: chars, ...scope });
      got.push(...r.items.filter((i) => i.type !== "reasoning"));
      if (!r.hasMore || r.nextPosition == null) break;
      start = r.nextPosition;
    }
    return {
      threadId,
      environmentId,
      link: t.link,
      thread: {
        title: t.title,
        status: t.status,
        model: `${t.providerInstanceId}/${t.model}`,
        worktreePath: t.worktreePath,
        branch: t.branch,
        activeRunId: t.activeRunId,
        pendingRequestCount: t.pendingRequestCount,
        pullRequests: (t.pullRequests ?? []).map((p) => `${p.url ?? p.number}:${p.state}`),
        itemCount: t.itemCount,
      },
      recentRuns: (head.recentRuns ?? []).slice(0, 3).map((r) => ({ runId: r.runId, ordinal: r.ordinal, status: r.status, model: r.model, requestedAt: r.requestedAt, startedAt: r.startedAt, completedAt: r.completedAt })),
      task: clip(head.items.find((i) => i.type === "user_message")?.text, 6000),
      ...(queue ? { queue: await queueOf(threadId, scope) } : {}),
      activity: (after == null ? got.slice(-items) : got.slice(0, items)).map((i) => ({
        pos: i.position,
        at: i.updatedAt?.slice(0, 19),
        type: i.type,
        ...(i.title ? { title: i.title } : {}),
        ...(i.type === "user_message" ? { from: i.createdBy === "user" ? "用户" : "注入", messageId: i.messageId } : {}),
        text: clip(i.text, chars),
      })),
    };
  } catch (e) {
    return { threadId, environmentId, error: String(e.message ?? e) };
  }
}

async function prEvidence(spec, { chars }) {
  const [pr, url] = splitAt(spec);
  try {
    return { pr, ...(await prDetailOf(pr, url, { chars: Math.min(chars, 800) })) };
  } catch (e) {
    return { pr, error: String(e.message ?? e) };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.threads.length && !opts.prs.length) {
    console.error("用法：node patrol-evidence.mjs --thread <threadId>[@<environmentId>] ... --pr <owner/repo#N>[@<PR URL>] ...");
    process.exit(2);
  }
  configurePr({ convergenceAudit: loadConfig().config.convergenceAudit });
  const out = { threads: [], prs: [] };
  if (opts.threads.length) {
    if (!hasSession()) {
      console.error(NO_SESSION);
      process.exit(2);
    }
    await connect("t3-patrol-evidence");
    out.threads = await pool(opts.threads, 4, (s) => threadEvidence(s, opts));
  }
  out.prs = await pool(opts.prs, 3, (s) => prEvidence(s, opts));
  console.log(JSON.stringify(out, null, 1));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
