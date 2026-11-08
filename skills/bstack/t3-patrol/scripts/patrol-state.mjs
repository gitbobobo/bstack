#!/usr/bin/env node
// 巡检跨轮状态：上一轮的快照时间与模型档位、各环境的资源探测结果。
// 存进文件而不是靠巡检线程的对话记忆：分诊要知道「上一轮以来有没有变化」，档位判定要知道「上一轮有没有额度失败」，
// 这些事实留在上下文里会随线程变长而越来越贵，换新线程就全丢。
//
// 文件：<配置目录>/state/t3-patrol.json（只在本机，state/ 不进配置仓库）。
// 用法：
//   node patrol-state.mjs                                                   输出当前状态
//   node patrol-state.mjs commit --snapshot <快照> --tier <档位 name> [--quota-failure]   一轮结束时记账
//   node patrol-state.mjs probe --env <environmentId> --disk-free <GB>       记下资源探测结果

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./patrol-config.mjs";

export const statePath = (env = process.env) => join(configDir(env), "state", "t3-patrol.json");

export function loadState(env = process.env) {
  try {
    const s = JSON.parse(readFileSync(statePath(env), "utf8"));
    return { lastRound: s.lastRound ?? null, probes: s.probes ?? {} };
  } catch {
    return { lastRound: null, probes: {} };
  }
}

function saveState(state, env = process.env) {
  const file = statePath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
}

// 探测结果在 ttlHours 内有效；过期或没有时返回 null，容量按名额算并提示先探测。
export function probeFor(state, environmentId, ttlHours, now = Date.now()) {
  const p = state.probes?.[environmentId];
  if (!p || !Number.isFinite(p.diskFreeGB)) return null;
  const age = now - Date.parse(p.at ?? "");
  return age >= 0 && age < ttlHours * 3600 * 1000 ? p : null;
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
  } else if (cmd === "commit") {
    const file = opt("snapshot");
    const tier = opt("tier");
    if (!file || !tier) {
      console.error("用法：node patrol-state.mjs commit --snapshot <快照> --tier <档位 name> [--quota-failure]");
      process.exit(2);
    }
    const snap = JSON.parse(readFileSync(file, "utf8"));
    const lastFullAt = snap.triage?.full ? snap.generatedAt : (state.lastRound?.lastFullAt ?? null);
    state.lastRound = { at: new Date().toISOString(), snapshotAt: snap.generatedAt, lastFullAt, tier, quotaFailure: args.includes("--quota-failure") };
    saveState(state);
    console.log(JSON.stringify(state.lastRound));
  } else if (cmd === "probe") {
    const env = opt("env");
    const free = Number(opt("disk-free"));
    if (!env || !Number.isFinite(free)) {
      console.error("用法：node patrol-state.mjs probe --env <environmentId> --disk-free <GB>");
      process.exit(2);
    }
    state.probes[env] = { diskFreeGB: free, at: new Date().toISOString() };
    saveState(state);
    console.log(JSON.stringify({ env, ...state.probes[env] }));
  } else {
    console.error(`未知子命令：${cmd}`);
    process.exit(2);
  }
}
