#!/usr/bin/env node
// 快照摘要：巡检每轮一次读完的精简版，取代「jq 裁一份再分三段读」。
// 有事候选给判定字段，静默候选每环境一行，体检清单只给要动手的条目；需要别的字段再回完整快照按字段查。
//
// 用法：node patrol-brief.mjs <快照文件>   （patrol-snapshot.mjs --brief <文件> 会顺带写出同样内容）

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOT_DROP = new Set(["id", "createdBy", "updatedAt", "projectId", "model", "hasWorktree", "lastRunEndedAt", "needsWatch", "needsWatchPrs", "needsWatchUrls", "needsRename", "renameReasons", "needsConvergenceAudit", "triage", "sampleCommand", "recentToolCalls"]);
const EMPTY = (v) => v == null || v === 0 || v === false || (Array.isArray(v) && !v.length);
const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, n)}…` : String(t));
const slimPr = (h) => {
  const { host, inline24h, lastCommentBy, ...rest } = h;
  return { ...rest, checks: (h.checks ?? []).map((c) => `${c.name}:${c.state}@${String(c.at ?? "").slice(5, 16)}${c.desc ? ` ${c.desc}` : ""}`) };
};

export function briefOf(snap) {
  const envs = (snap.environments ?? []).map((e) => {
    if (e.error) return { alias: e.alias ?? e.label, environmentId: e.environmentId, error: e.error };
    const hot = (e.candidates ?? []).filter((c) => c.triage === "hot");
    const quiet = (e.candidates ?? []).filter((c) => c.triage !== "hot");
    const cap = e.capacity ?? {};
    return {
      alias: e.alias ?? e.label,
      environmentId: e.environmentId,
      checks: e.checks,
      capacity: {
        used: cap.used,
        max: cap.max,
        free: Object.fromEntries(Object.entries(cap.freeByRepo ?? {}).filter(([, n]) => n > 0)),
        ...(cap.blocked ? { blocked: cap.blocked } : {}),
        ...(cap.disk?.freeGB != null ? { diskFreeGB: cap.disk.freeGB } : {}),
      },
      hot: hot.map((c) => {
        const o = Object.fromEntries(Object.entries(c).filter(([k, v]) => !HOT_DROP.has(k) && !EMPTY(v)));
        if (o.prHealth) o.prHealth = o.prHealth.map(slimPr);
        // 摘要里每条尾部消息留 400 字；要全文时读完整快照或用 patrol-evidence。
        if (o.tail) o.tail = o.tail.map((t) => clip(t, 400));
        return o;
      }),
      quiet: quiet.map((c) => `${c.title}（${(c.triageReasons ?? []).join("、")}）${c.waitingResources ? ` 等待资源：${c.waitingResources.line}` : ""} ${c.link}`),
      failedThreads: (e.failedThreads ?? []).map(({ tail, task, prs, runs, ...f }) => f),
      needsWatch: (e.needsWatchThreads ?? []).length,
      needsRename: (e.needsRenameThreads ?? []).map(({ id, title, reasons, prs }) => ({ id, title, reasons, prs })),
      convergenceAudit: e.convergenceAuditThreads ?? [],
    };
  });
  return {
    generatedAt: snap.generatedAt,
    triage: snap.triage,
    lastRound: snap.lastRound,
    pendingHandoffs: snap.pendingHandoffs ?? [],
    modelLadder: (snap.modelLadder ?? []).map((t) => t.name),
    config: { warnings: snap.config?.warnings ?? [], errors: snap.config?.errors ?? [] },
    environmentsFile: snap.environmentsFile,
    unreachable: (snap.unreachable ?? []).map((u) => ({ alias: u.alias ?? u.label, environmentId: u.environmentId, status: u.status })),
    environments: envs,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：node patrol-brief.mjs <快照文件>");
    process.exit(2);
  }
  console.log(JSON.stringify(briefOf(JSON.parse(readFileSync(file, "utf8"))), null, 1));
}
