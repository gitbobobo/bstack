#!/usr/bin/env node
// 补货清单：按题库缺口为每个仓库列待研判候选，并为补货子代理各写一份输入切片。题库是派活的唯一出队来源，本脚本不分配空位。
//
// 用法：node dispatch-plan.mjs --capacity <快照> [--brief-dir <目录>] [--excerpt 0]
// 快照可以是完整快照或 --capacity-only（都带 environments[].projects/capacity/openThreads）。
// 输出 { refill: [refillStatus…], repos: [{ repo, deficit, devices, shortlist, excluded, parked, poolMissing, ledgerStale, more, skip? }], briefs, warnings }：
//   refill      各仓库目标库存（stock.multiplier × 可派设备所属池名额）、未过期 ready 库存与缺口
//   shortlist   缺口仓库的待研判候选（已在库存里的不再列），粗排后取前 max(5, 缺口×2) 条；pooled 是池里已有的过期/阻塞/待核旧结论
//   excluded    台账在派、暂缓标签或回读确认未结线程命中（范围待子代理复核）的项
//   parked      池里 stock.recheckHours 内的阻塞/待核结论且来源没更新过：不重复研判，到期或来源更新后回到 shortlist
//   poolMissing 池里有、准入列表已没有的条目：子代理核实后移除
//   ledgerStale 台账在派、但线程已不在可达环境的未结列表里（或认领未记线程）：子代理对账
//   skip        以上都没有待办时的原因：不写切片、不派补货子代理
// 粗排只是排序提示：按标题与标签关键词归类（崩溃/丢数据 → 门禁/构建/发版 → 安全 → 功能错误 → 性能 → 体验 → 重构），用户优先标签在先。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./dispatch-config.mjs";
import { ledgerSummary, readLedger, run } from "./issue-source.mjs";
import { loadEnvironments } from "../../t3-patrol/scripts/patrol-config.mjs";
import { call, connect, hasSession, pool } from "../../t3-patrol/scripts/t3-mcp.mjs";

import { labelPolicy } from "./dispatch-labels.mjs";
import { fresh, readPool, refillStatus, stockOf } from "./candidate-pool.mjs";
import { findOpenThread, refRe } from "./dispatch-duplicates.mjs";

const CATEGORIES = [
  ["无法使用/丢数据", /崩溃|闪退|无法启动|启动失败|白屏|卡死|丢失|误删|数据损坏|无法播放|crash|panic/i],
  ["阻塞开发/发版", /门禁|\bgate\b|构建|编译失败|\bCI\b|发版|发布|供应链|release|签名/i],
  ["安全", /安全|漏洞|CVE|证书|TLS|越权|SQL 注入|泄露|依赖公告|advisor/i],
  ["功能错误", /错误|失败|不生效|异常|无效|不一致|bug|修复|回归|错位/i],
  ["性能", /性能|卡顿|慢|耗时|内存|CPU|功耗|滚动/i],
  ["体验与文案", /体验|文案|样式|动画|对齐|视觉|交互|图标|提示/i],
  ["架构重构", /重构|架构|清理|迁移|拆分|收口|统一/i],
];
const LEVEL = (s) => (/(^|[\s【\[(（])高([\s】\])）]|$)|\bP[01]\b/.test(s) ? 0 : /(^|[\s【\[(（])低([\s】\])）]|$)|\bP3\b/.test(s) ? 2 : 1);
const NEEDS_INFO = /待补|待补充|缺少?(复现|机型|日志|信息)|需要更多信息|need more info/i;

// 标题自称「架构：」、重构或清理死代码的，先归架构：这类标题常顺带提到构建、注入等词。
const ARCH_FIRST = /架构[:：]|重构|无用代码|死代码/;

export function rankOf(c) {
  const text = `${c.title} ${(c.labels ?? []).join(" ")}`;
  let i = ARCH_FIRST.test(text) ? CATEGORIES.length - 1 : CATEGORIES.findIndex(([, re]) => re.test(text));
  // 没命中关键词的放在功能错误与性能之间：不知道就别垫底，留给模型看正文。
  const cat = i < 0 ? 4.5 : i + 1;
  return { category: i < 0 ? "未分类" : CATEGORIES[i][0], rank: cat * 10 + LEVEL(text), needsInfo: NEEDS_INFO.test(c.excerpt ?? "") };
}

export function buildPlan({ capacity, config, environments, ledger, listOf, candidatePool = {}, now = Date.now() }) {
  const summary = ledgerSummary(ledger, { now });
  const activeIds = new Set(summary.active.map((e) => e.id));
  const envs = capacity.environments ?? [];
  const openThreads = envs.flatMap((e) => (e.openThreads ?? []).map((t) => ({ ...t, environmentId: e.environmentId })));
  // 只有拿到未结线程列表的可达环境才能判定台账线程已结束。
  const listedEnvs = new Set(envs.filter((e) => !e.error && Array.isArray(e.openThreads)).map((e) => e.environmentId));
  const open = new Set(openThreads.map((t) => `${t.environmentId}/${t.id}`));
  const stock = config.stock ?? {};
  const unchanged = (old, c) => old && old.state !== "ready" && fresh(old, now, stock.recheckHours ?? 24) && old.issueUpdatedAt && c.updatedAt
    && Date.parse(c.updatedAt) <= Date.parse(old.issueUpdatedAt);
  const refill = refillStatus({ repos: config.repos, pool: { repos: candidatePool }, envs, environments, activeIds, multiplier: stock.multiplier, maxAgeHours: stock.maxAgeHours, now });
  const repos = [];
  for (const s of refill.filter((x) => x.deficit > 0 || x.deviceGaps.length)) {
    const entries = candidatePool[s.repo] ?? [];
    const inStock = new Set(stockOf(entries, { now, maxAgeHours: stock.maxAgeHours }).map((e) => e.id));
    const saved = new Map(entries.map((e) => [e.id, e]));
    const listed = listOf(s.repo);
    const r = { repo: s.repo, deficit: s.deficit, devices: s.devices, deviceGaps: s.deviceGaps, deviceReviews: [], shortlist: [], excluded: [], parked: [], more: 0 };
    r.poolMissing = entries.filter((e) => !listed.candidates.some((c) => c.id === e.id)).map(({ id, ref }) => ({ id, ref }));
    r.ledgerStale = [
      ...summary.active.filter((e) => e.repo === s.repo && listedEnvs.has(e.environmentId) && !open.has(`${e.environmentId}/${e.threadId}`)),
      ...summary.pending.filter((e) => e.repo === s.repo),
    ].map(({ id, ref, event }) => ({ id, ...(ref ? { ref } : {}), event }));
    const cands = [];
    for (const c of listed.candidates) {
      const old = saved.get(c.id);
      if (inStock.has(c.id)) {
        if (activeIds.has(c.id) || labelPolicy(c.labels).deferred) continue;
        const recent = fresh(old, now, stock.recheckHours ?? 24) && old.issueUpdatedAt && c.updatedAt
          && Date.parse(c.updatedAt) <= Date.parse(old.issueUpdatedAt);
        const devices = s.deviceGaps.map((g) => g.device).filter((d) => !old.devices.includes(d)
          && !(recent && Object.hasOwn(old.deviceExclusions ?? {}, d)));
        if (devices.length) r.deviceReviews.push({ id: c.id, ref: c.ref, title: c.title, devices });
        continue;
      }
      const thread = openThreads.find((t) => refRe(c.ref).test(t.title ?? ""));
      if (activeIds.has(c.id)) r.excluded.push({ ref: c.ref, title: c.title, reason: "台账里已派出、线程未了结" });
      else if (labelPolicy(c.labels).deferred) r.excluded.push({ ref: c.ref, title: c.title, reason: "bstack:defer 暂缓自动派活" });
      else if (unchanged(old, c)) r.parked.push({ ref: c.ref, state: old.state, checkedAt: old.checkedAt });
      else cands.push({ ...c, ...rankOf(c), priority: labelPolicy(c.labels).priority, ...(thread ? { threadMatch: thread } : {}),
        ...(old ? { pooled: { state: old.state, checkedAt: old.checkedAt, reason: old.reason, nextCheck: old.nextCheck } } : {}) });
    }
    cands.sort((a, b) => Number(b.priority) - Number(a.priority) || a.needsInfo - b.needsInfo || a.rank - b.rank || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const n = Math.max(5, Math.max(s.deficit, ...s.deviceGaps.map((g) => g.need)) * 2);
    r.shortlist = cands.slice(0, n).map(({ id, ref, title, labels, excerpt, category, rank, needsInfo, priority, attempts, updatedAt, threadMatch, pooled }) =>
      ({ id, ref, title, labels, excerpt, category, rank, needsInfo, priority, updatedAt, ...(threadMatch ? { threadMatch } : {}), ...(attempts ? { attempts } : {}), ...(pooled ? { pooled } : {}) }));
    r.more = Math.max(0, cands.length - n);
    r.sourceSkipped = listed.skipped.length;
    r.labelConflicts = listed.skipped.filter((x) => x.conflict);
    repos.push(r);
  }
  return { refill, repos };
}

// 补货子代理只在有待办时派：待研判候选、需复核的线程命中、池里失效条目或台账对账。查重会改 shortlist，须在其后调用。
export function skipReasonOf(r) {
  if (r.shortlist.length || r.deviceReviews?.length || r.poolMissing?.length || r.ledgerStale?.length || r.excluded.some((e) => e.duplicateReview)) return null;
  const count = (re) => r.excluded.filter((e) => re.test(e.reason)).length;
  const parts = [["题库阻塞/待核且来源未更新", r.parked.length], ["在派", count(/台账/)], ["暂缓", count(/defer/)], ["来源跳过", r.sourceSkipped ?? 0]];
  return `无待研判内容：${parts.filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join("，") || "来源无可派问题"}`;
}

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
export const briefName = (repo) => `${repo.replace(/[^\w.-]+/g, "_")}.json`;

// 补货子代理的唯一输入：只含本仓库的切片与命令用法，省掉子代理自己摸大文件结构。
export function repoBriefOf(plan, repo, { capacity, ledger = [], scripts = SCRIPTS } = {}) {
  const r = plan.repos.find((x) => x.repo === repo);
  const s = plan.refill.find((x) => x.repo === repo);
  const summary = ledgerSummary(ledger);
  const mine = (e) => e.repo === repo;
  const pool = join(scripts, "candidate-pool.mjs");
  return {
    repo,
    need: r.deficit,
    target: s.target,
    stock: s.stock,
    devices: r.devices,
    deviceGaps: r.deviceGaps,
    deviceReviews: r.deviceReviews,
    maxAgeHours: s.maxAgeHours,
    openThreads: (capacity?.environments ?? []).flatMap((e) => (e.openThreads ?? []).map((t) => ({ ...t, environmentId: e.environmentId }))),
    shortlist: r.shortlist,
    more: r.more,
    excluded: r.excluded,
    parked: r.parked ?? [],
    poolMissing: r.poolMissing ?? [],
    ledgerStale: r.ledgerStale ?? [],
    ledger: { active: summary.active.filter(mine), recent: summary.recent.filter(mine) },
    commands: {
      list: `node ${join(scripts, "issue-source.mjs")} list --repo ${repo} --excerpt 0`,
      show: `node ${join(scripts, "issue-source.mjs")} show --repo ${repo} --id <list 输出的 id，不是 ref>`,
      pool: `node ${pool} list --repo ${repo}`,
      validate: `node ${pool} validate --file <patch.json>`,
      apply: `node ${pool} apply --repo ${repo} --file <patch.json>`,
    },
  };
}

// 表内问题再按编号在各设备该仓库的项目里搜一次：标题不含编号的线程靠标题查重会漏。
export async function searchDupes(plan, capacity, callTool = call) {
  const envs = capacity.environments ?? [];
  for (const r of plan.repos) {
    if (!r.shortlist.length) continue;
    const scopes = envs.flatMap((e) => {
      const p = (e.projects ?? []).find((x) => x.canonicalKey?.toLowerCase() === r.repo);
      return p && !e.error ? [{ environmentId: e.environmentId, projectId: p.id }] : [];
    });
    const hits = await pool(r.shortlist, 4, async (c) => {
      try { return await findOpenThread(c.ref, scopes, callTool); }
      catch (e) {
        c.duplicateCheckError = e.message;
        return null;
      }
    });
    const duplicates = new Set();
    r.shortlist.forEach((c, i) => {
      if (hits[i]) {
        duplicates.add(c.id);
        r.excluded.push({ ref: c.ref, title: c.title, reason: `回读确认未结线程「${hits[i].title}」，任务范围待复核`, duplicateReview: true, environmentId: hits[i].environmentId, threadId: hits[i].threadId, link: hits[i].link });
      }
    });
    r.shortlist = r.shortlist.filter((c) => !duplicates.has(c.id));
  }
}

// 供 patrol-round start 直接调用：读配置、来源与池，查重后写切片。
export async function refillPlan({ capacity, briefDir, excerpt = 0, connected = false }) {
  const { config, errors } = loadConfig();
  if (errors.length) throw new Error(errors.join("；"));
  const warnings = [];
  let candidatePool = {};
  try { candidatePool = readPool().state.repos; }
  catch (e) { warnings.push(`候选池读取失败，本轮按空库存补货、保留原文件：${e.message}`); }
  const ledger = readLedger();
  const plan = buildPlan({ capacity, config, environments: loadEnvironments().environments, ledger, listOf: (repo) => run("list", { repo, excerpt }), candidatePool });
  if (plan.repos.length && hasSession()) {
    if (!connected) await connect("t3-dispatch-plan");
    await searchDupes(plan, capacity);
  } else if (plan.repos.length) warnings.push("没有 T3 MCP 会话，标题命中仅作 threadMatch 线索");
  for (const r of plan.repos) {
    const skip = skipReasonOf(r);
    if (skip) r.skip = skip;
  }
  const work = plan.repos.filter((r) => !r.skip);
  if (briefDir && work.length) {
    mkdirSync(briefDir, { recursive: true });
    plan.briefs = {};
    for (const r of work) {
      const file = join(briefDir, briefName(r.repo));
      writeFileSync(file, `${JSON.stringify(repoBriefOf(plan, r.repo, { capacity, ledger }), null, 1)}\n`);
      plan.briefs[r.repo] = file;
    }
  }
  if (warnings.length) plan.warnings = warnings;
  return plan;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const file = opt("capacity");
  if (!file) {
    console.error("用法：node dispatch-plan.mjs --capacity <快照> [--brief-dir <目录>] [--excerpt 0]");
    process.exit(2);
  }
  try {
    const plan = await refillPlan({ capacity: JSON.parse(readFileSync(file, "utf8")), briefDir: opt("brief-dir"), excerpt: Number(opt("excerpt", 0)) });
    console.log(JSON.stringify(plan, null, 1));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
