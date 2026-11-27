#!/usr/bin/env node
// 巡检跨轮状态：上一轮的快照时间、各环境占用数、待交接队列与线程状态表。
//
// 文件：<配置目录>/state/t3-patrol.json（只在本机，state/ 不进配置仓库）。
// 用法：
//   node patrol-state.mjs                                                                 输出当前状态
//   node patrol-state.mjs commit --snapshot <快照>                                      一轮结束时记账
//   node patrol-state.mjs handoff-put --file <JSON>                                     交接入账/更新
//   node patrol-state.mjs handoff-resolve --file <JSON>                                 有接手/撤销证据后销账
// 线程状态表 threads 由 patrol-round finish 按本轮研判写入：上次动作、在等什么、下次复查时间、同一动作连发次数。
// 交接文件可以是单项或数组；数组先全部校验，任一项不合格就整批不写。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./patrol-config.mjs";

export const statePath = (env = process.env) => join(configDir(env), "state", "t3-patrol.json");

export function loadState(env = process.env) {
  try {
    const saved = JSON.parse(readFileSync(statePath(env), "utf8"));
    return { lastRound: saved.lastRound ?? null, pendingHandoffs: saved.pendingHandoffs ?? [], managedThreads: saved.managedThreads ?? [], threads: saved.threads ?? {} };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { lastRound: null, pendingHandoffs: [], managedThreads: [], threads: {} };
  }
}

export const threadKey = (environmentId, threadId) => `${environmentId ?? ""}/${threadId}`;

// 同一 kind 的写动作连发计数：重复推进无效时升级为阻塞，而不是每轮重判再发一遍。
// alive 是本轮快照里仍存在的线程键，其余条目丢弃，状态表不随历史线程膨胀。
export function recordDecisions(state, decisions, { now = Date.now(), alive = null } = {}) {
  const threads = state.threads ??= {};
  for (const d of decisions) {
    const key = threadKey(d.environmentId, d.threadId);
    const prev = threads[key];
    const acted = d.action !== "none";
    const count = acted ? (prev?.kind === d.kind && prev.count ? prev.count + 1 : 1) : 0;
    threads[key] = {
      kind: d.kind, action: d.action, at: new Date(now).toISOString(), count,
      ...(d.waitFor ? { waitFor: d.waitFor } : {}),
      ...(d.recheckMinutes > 0 ? { recheckAt: new Date(now + d.recheckMinutes * 60000).toISOString() } : {}),
    };
  }
  if (alive) for (const key of Object.keys(threads)) if (!alive.has(key)) delete threads[key];
  return threads;
}

export function commitRound(state, snap, { now = Date.now() } = {}) {
  const lastFullAt = snap.triage?.full ? snap.generatedAt : (state.lastRound?.lastFullAt ?? null);
  // 各环境占用数：下一轮据此判断设备是否空出了名额，叫醒在等资源的线程。
  const occupancy = Object.fromEntries((snap.environments ?? []).filter((e) => e.capacity).map((e) => [e.environmentId, e.capacity.used]));
  state.lastRound = { at: new Date(now).toISOString(), snapshotAt: snap.generatedAt, lastFullAt, occupancy, handoffQueueVersion: 1 };
  return state.lastRound;
}

// 持久归属：派活台账全部 launched 记录 + 巡检交接目标；不按标题、创建者或近期时间推断。
export function managedThreadsOf(state, env = process.env) {
  let ledger = "";
  try {
    ledger = readFileSync(join(configDir(env), "state", "t3-dispatch.jsonl"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const out = [...(state.managedThreads ?? [])];
  for (const line of ledger.split("\n").filter((s) => s.trim())) {
    const e = JSON.parse(line);
    if (e.event === "launched" && e.environmentId && e.threadId) out.push({ environmentId: e.environmentId, threadId: e.threadId });
  }
  for (const h of state.pendingHandoffs ?? []) {
    const target = handoffTarget(h);
    if (target) out.push(target);
  }
  return [...new Map(out.map((x) => [JSON.stringify([x.environmentId, x.threadId]), x])).values()];
}

function handoffTarget(entry) {
  const match = String(entry.launchedThreadLink ?? "").match(/^<?t3-thread:\/\/v2\/([^/]+)\/([^/<>]+)>?$/);
  return match && match[1] === entry.targetEnvironmentId ? { environmentId: match[1], threadId: match[2] } : null;
}

export function putHandoff(state, entry) {
  for (const key of ["sourceEnvironmentId", "sourceThreadId", "sourceLink", "targetEnvironmentId", "canonicalKey", "task", "handoffRef", "waitingSince", "blocker"]) {
    if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`交接缺少 ${key}`);
  }
  if (!Number.isFinite(Date.parse(entry.waitingSince))) throw new Error("waitingSince 必须是日期");
  if (entry.launch != null) {
    for (const key of ["projectId", "title", "message"]) {
      if (typeof entry.launch[key] !== "string" || !entry.launch[key].trim()) throw new Error(`launch 缺少 ${key}`);
    }
    if (Object.hasOwn(entry.launch, "verificationOnly") && typeof entry.launch.verificationOnly !== "boolean") throw new Error("launch.verificationOnly 必须是布尔值");
  }
  if (entry.sourceRelease != null) {
    for (const key of ["runId", "worktreePath", "verifiedAt", "deliveryRef", "idleRef"]) {
      if (typeof entry.sourceRelease[key] !== "string" || !entry.sourceRelease[key].trim()) throw new Error(`sourceRelease 缺少 ${key}`);
    }
    if (!Number.isFinite(Date.parse(entry.sourceRelease.verifiedAt))) throw new Error("sourceRelease.verifiedAt 必须是日期");
  }
  const pending = state.pendingHandoffs ??= [];
  const i = pending.findIndex((x) => x.sourceEnvironmentId === entry.sourceEnvironmentId && x.sourceThreadId === entry.sourceThreadId);
  // 更新阻塞或目标时保留本机释放凭据；显式 sourceRelease:null 可撤回。
  const next = { ...entry, waitingSince: i < 0 ? entry.waitingSince : pending[i].waitingSince };
  if (i >= 0 && !Object.hasOwn(entry, "sourceRelease") && Object.hasOwn(pending[i], "sourceRelease")) next.sourceRelease = pending[i].sourceRelease;
  if (i < 0) pending.push(next);
  else pending[i] = next;
  const target = handoffTarget(next);
  if (target) {
    const managed = state.managedThreads ??= [];
    if (!managed.some((x) => x.environmentId === target.environmentId && x.threadId === target.threadId)) managed.push(target);
  }
}

export function resolveHandoff(state, entry) {
  if (!entry.sourceEnvironmentId || !entry.sourceThreadId || !entry.evidenceRef || !["accepted", "cancelled"].includes(entry.outcome)) {
    throw new Error("交接销账需要来源身份、outcome（accepted/cancelled）及 evidenceRef");
  }
  // 先固化旧队列中的目标归属，再销账，避免下一轮目标线程丢失巡检归属。
  for (const h of state.pendingHandoffs ?? []) {
    const target = handoffTarget(h);
    if (target) {
      const managed = state.managedThreads ??= [];
      if (!managed.some((x) => x.environmentId === target.environmentId && x.threadId === target.threadId)) managed.push(target);
    }
  }
  state.pendingHandoffs = (state.pendingHandoffs ?? []).filter((x) => x.sourceEnvironmentId !== entry.sourceEnvironmentId || x.sourceThreadId !== entry.sourceThreadId);
}

export function saveState(state, env = process.env) {
  const file = statePath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const state = loadState();
  const cmd = args[0];
  if (!cmd) {
    console.log(JSON.stringify({ file: statePath(), ...state }, null, 1));
  } else if (cmd === "handoff-put" || cmd === "handoff-resolve") {
    const file = opt("file");
    if (!file) throw new Error(`${cmd} 需要 --file <UTF-8 JSON 文件>`);
    const input = JSON.parse(readFileSync(file, "utf8"));
    const next = structuredClone(state);
    for (const entry of Array.isArray(input) ? input : [input]) {
      if (cmd === "handoff-put") putHandoff(next, entry);
      else resolveHandoff(next, entry);
    }
    saveState(next);
    state.pendingHandoffs = next.pendingHandoffs;
    console.log(JSON.stringify({ pendingHandoffs: state.pendingHandoffs }));
  } else if (cmd === "commit") {
    const file = opt("snapshot");
    if (!file) {
      console.error("用法：node patrol-state.mjs commit --snapshot <快照>");
      process.exit(2);
    }
    commitRound(state, JSON.parse(readFileSync(file, "utf8")));
    saveState(state);
    console.log(JSON.stringify(state.lastRound));
  } else {
    console.error(`未知子命令：${cmd}`);
    process.exit(2);
  }
}
