#!/usr/bin/env node
// 派活备选：从空位反推，只为有空位的仓库列候选，查重、粗排后给一张精简表，模型只在表里挑。
// 取代「把全部候选导成文本逐段读」——那一步在首次接入新仓库时独占了一轮巡检的大半时间。
//
// 用法：node dispatch-plan.mjs --capacity <patrol-snapshot.mjs --capacity-only 的输出> [--per-slot 3] [--excerpt 200]
// 输出 { slots, repos: [{ repo, slots, devices, shortlist, excluded, more }], skipped }：
//   slots       本轮最多还能派几个（perRun、perDay 余量与各仓库空位之和取小）；为 0 时不列候选
//   devices     该仓库有空位的设备（alias、environmentId、projectId、free）
//   shortlist   粗排后的前 max(5, 空位×per-slot) 条：ref、id、title、labels、excerpt、category（粗分类）、
//               rank（越小越优先）、needsInfo（正文像在等补信息）、attempts
//   excluded    已有未结线程或台账在派的问题（附依据）；more 是排在表外的候选数
// 粗排只是排序提示：按标题与标签的关键词归类（崩溃/丢数据 → 门禁/构建/发版 → 安全 → 功能错误 → 性能 → 体验 → 重构），
// 同类按「高 / 中 / 低」标记。挑选仍按 SKILL.md 第 3 步逐条判断。
// 有 T3 MCP 会话时，再对表内问题在各设备该仓库的项目里 t3_thread_search 查重；没有会话只按标题与台账查重。

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./dispatch-config.mjs";
import { ledgerSummary, readLedger, run } from "./issue-source.mjs";
import { loadEnvironments } from "../../t3-patrol/scripts/patrol-config.mjs";
import { call, connect, hasSession, pool } from "../../t3-patrol/scripts/t3-mcp.mjs";

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

const refRe = (ref) => new RegExp(`(^|[^\\w-])${String(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");

export function buildPlan({ capacity, config, environments, ledger, listOf, perSlot = 3 }) {
  const summary = ledgerSummary(ledger);
  const dayLeft = Math.max(0, config.limits.perDay - summary.launched);
  const budget = Math.min(config.limits.perRun, dayLeft);
  const activeIds = new Set(summary.active.map((e) => e.id));
  const envs = capacity.environments ?? [];
  const aliasOf = new Map(Object.entries(environments).map(([alias, e]) => [e.environmentId, alias]));
  const openThreads = envs.flatMap((e) => (e.openThreads ?? []).map((t) => ({ ...t, environmentId: e.environmentId })));
  const repos = [];
  const skipped = [];
  for (const r of config.repos) {
    const allowed = r.devices?.length ? new Set(r.devices.map((d) => environments[d]?.environmentId).filter(Boolean)) : null;
    const devices = [];
    for (const e of envs) {
      if (e.error || (allowed && !allowed.has(e.environmentId))) continue;
      const project = (e.projects ?? []).find((p) => p.canonicalKey?.toLowerCase() === r.repo);
      if (!project) continue;
      const free = e.capacity?.freeByRepo?.[project.canonicalKey] ?? 0;
      if (free > 0) devices.push({ alias: aliasOf.get(e.environmentId) ?? e.label, environmentId: e.environmentId, projectId: project.id, free });
      else skipped.push({ repo: r.repo, device: aliasOf.get(e.environmentId) ?? e.label, reason: e.capacity?.blocked?.join("；") || "名额已满" });
    }
    const slots = Math.min(budget, devices.reduce((s, d) => s + d.free, 0));
    repos.push({ repo: r.repo, slots, devices, shortlist: [], excluded: [], more: 0 });
  }
  const slots = Math.min(budget, repos.reduce((s, r) => s + r.slots, 0));
  if (slots === 0) return { slots, budget, launchedToday: summary.launched, repos: repos.map(({ shortlist, excluded, more, ...r }) => r), skipped };
  for (const r of repos) {
    if (!r.slots) continue;
    const listed = listOf(r.repo);
    const cands = [];
    for (const c of listed.candidates) {
      const thread = openThreads.find((t) => refRe(c.ref).test(t.title ?? ""));
      if (thread) r.excluded.push({ ref: c.ref, title: c.title, reason: `已有未结线程「${thread.title}」`, link: thread.link });
      else if (activeIds.has(c.id)) r.excluded.push({ ref: c.ref, title: c.title, reason: "台账里已派出、线程未了结" });
      else cands.push({ ...c, ...rankOf(c) });
    }
    cands.sort((a, b) => a.needsInfo - b.needsInfo || a.rank - b.rank || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const n = Math.max(5, r.slots * perSlot);
    r.shortlist = cands.slice(0, n).map(({ id, ref, title, labels, excerpt, category, rank, needsInfo, attempts }) => ({ id, ref, title, labels, excerpt, category, rank, needsInfo, ...(attempts ? { attempts } : {}) }));
    r.more = Math.max(0, cands.length - n);
    r.sourceSkipped = listed.skipped.length;
  }
  return { slots, budget, launchedToday: summary.launched, repos, skipped };
}

// 表内问题再按编号在各设备该仓库的项目里搜一次：标题不含编号的线程靠标题查重会漏。
async function searchDupes(plan, capacity) {
  const envs = capacity.environments ?? [];
  for (const r of plan.repos) {
    if (!r.shortlist.length) continue;
    const scopes = envs.flatMap((e) => {
      const p = (e.projects ?? []).find((x) => x.canonicalKey?.toLowerCase() === r.repo);
      return p && !e.error ? [{ environmentId: e.environmentId, projectId: p.id }] : [];
    });
    const hits = await pool(r.shortlist, 4, async (c) => {
      for (const s of scopes) {
        const res = await call("t3_thread_search", { ...s, query: c.ref, limit: 5 }).catch(() => null);
        // 只认标题或用户消息（任务书）里的命中：代理在别的线程里顺口提到这个编号（如登记成后续）不算在做它。
        const t = (res?.matches ?? []).find((x) => x.source !== "assistant" && refRe(c.ref).test(`${x.title ?? ""} ${x.snippet ?? ""}`));
        if (t) return { ...t, environmentId: s.environmentId };
      }
      return null;
    });
    const keep = [];
    r.shortlist.forEach((c, i) => {
      if (hits[i]) r.excluded.push({ ref: c.ref, title: c.title, reason: `搜到未结线程「${hits[i].title}」`, link: hits[i].link });
      else keep.push(c);
    });
    r.shortlist = keep;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const file = opt("capacity");
  if (!file) {
    console.error("用法：node dispatch-plan.mjs --capacity <capacity-only 快照> [--per-slot 3] [--excerpt 200]");
    process.exit(2);
  }
  try {
    const { config, errors } = loadConfig();
    if (errors.length) throw new Error(errors.join("；"));
    const capacity = JSON.parse(readFileSync(file, "utf8"));
    const excerpt = Number(opt("excerpt", 200));
    const plan = buildPlan({
      capacity,
      config,
      environments: loadEnvironments().environments,
      ledger: readLedger(),
      listOf: (repo) => run("list", { repo, excerpt }),
      perSlot: Number(opt("per-slot", 3)),
    });
    if (plan.slots > 0 && hasSession()) {
      await connect("t3-dispatch-plan");
      await searchDupes(plan, capacity);
    } else if (plan.slots > 0) plan.warnings = ["没有 T3 MCP 会话，只按标题与台账查重；挑中的问题派出前按 SKILL.md 第 4 步手工搜一次"];
    console.log(JSON.stringify(plan, null, 1));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
