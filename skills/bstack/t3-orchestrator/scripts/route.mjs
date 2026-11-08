#!/usr/bin/env node
// 固定规则路由：输入任务类型（+已试入口），输出该用的 harness/模型/选项。
// 规则来自 route-config.mjs（route-data.mjs 默认值 + 用户配置 ~/.config/bstack/t3-orchestrator.json）；
// 本文件只做展开与过滤，不含可调整的策略。
//
// 子命令：
//   route.mjs select --task <key> [--vision]
//                    [--exclude <provider/model>]... [--exclude-provider <id>]...
//                    [--exclude-model <模型 key|provider/model>]...
//                    [--caps-file <path>] [--json]
//   route.mjs named <模型> [--provider <id>] [--caps-file ...] [--json]
//   route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]
//   route.mjs audit [--caps-file <path>] [--json]
//                                     审计生效路由数据全部入口与 ROUTES 行内 options
//                                     是否「目录可查 + 取值合法」，有问题 exit 1
//   route.mjs table [--json]          打印当前生效的路由数据与配置来源（供人工核对）
//   route.mjs tasks                   列出 --task 可用取值
//
// 退出码：0 选出/校验通过；1 无可用候选或校验违规；2 参数错误。
//
// 输入来源（脚本自取，不靠模型转述）：
//   capabilities  —— --caps-file 传 orchestrator_capabilities 的 JSON；文件 mtime 超
//                    CAPS_FILE_TTL_MS 时告警，并在「不可派/无此模型」类判定上标注过期；
//                    缺省为降级模式：pi 的模型清单取自本机 `pi --list-models`（T3 不刷新
//                    ~/.t3/caches/pi.json，曾因其陈旧把全部 cliproxyapi 入口判为无此 ID），
//                    其余 provider 读 ${T3_CACHE_DIR:-~/.t3/caches}/<provider>.json
//                    （无法验证 canRunChildTask，强告警）
// 额度不在这里判断：pi 入口由 cliproxyapi 自动路由，其余入口失败即换路。

import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROVIDER_RULES, MODELS, TASKS, ADVISOR_TASKS, ROUTES, MAX_ATTEMPTS, CONFIG, CONFIG_NOTES } from "./route-config.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const now = Date.now();
// caps 文件时效：provider 可派性/模型清单会随安装与刷新漂移，手工落盘的快照没有 TTL 概念
// （曾因此按 3 小时前的 canRunChildTask=false 跳过首选入口）。超阈值不拒用——该文件可能
// 仍是最佳数据源——但告警并给「不可派」类判定标过期，提示刷新后复核。
const CAPS_FILE_TTL_MS = 30 * 60 * 1000;

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = { exclude: [], excludeModel: [], excludeProvider: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "hard") {
        console.error("--hard 已移除：实现顾问单独跑 select --task design");
        process.exit(2);
      }
      if (["vision", "json", "user-named"].includes(key)) args[key] = true;
      else if (key === "exclude") args.exclude.push(argv[++i]);
      else if (key === "exclude-model") args.excludeModel.push(argv[++i]);
      else if (key === "exclude-provider") args.excludeProvider.push(argv[++i]);
      else args[key] = argv[++i];
    } else if (args._ === undefined) args._ = a;
    else (args._extra ??= []).push(a);
  }
  return args;
}

const entryId = (e) => `${e.provider}/${e.id}`;

// ---------- capabilities ----------

// 选项描述符 → { type, values:Set|null }；values 仅 select 类有取值集，boolean 为 null
function optionSpec(descriptors) {
  const spec = new Map();
  for (const o of descriptors ?? []) {
    spec.set(o.id, { type: o.type, values: o.options?.length ? new Set(o.options.map((v) => v.id)) : null });
  }
  return spec;
}

function loadProviders(capsFile) {
  const warnings = [];
  const providers = new Map(); // id -> {runnable, reason?, models:Set, optionSpecs:Map<modelId,Map<optionId,{type,values}>>, optionIds, cross:boolean}
  const capsJson = capsFile ? JSON.parse(readFileSync(capsFile, "utf8")) : null;
  if (capsJson) {
    const list = Array.isArray(capsJson) ? capsJson : (capsJson.providers ?? []);
    for (const p of list) {
      const optionSpecs = new Map();
      for (const m of p.models ?? []) optionSpecs.set(m.id, optionSpec(m.options));
      providers.set(p.providerInstanceId, {
        runnable: p.canRunChildTask === true,
        cross: p.canRunCrossProviderChildTask === true,
        reason: p.canRunChildTask ? undefined : (p.constraints ?? []).join("; ") || "canRunChildTask=false",
        models: new Set((p.models ?? []).map((m) => m.id)),
        optionSpecs,
        optionIds: new Map([...optionSpecs].map(([k, v]) => [k, new Set(v.keys())])),
      });
    }
    let capsStaleMin;
    try {
      const ageMs = now - statSync(capsFile).mtimeMs;
      if (ageMs > CAPS_FILE_TTL_MS) {
        capsStaleMin = Math.round(ageMs / 60000);
        warnings.push(
          `--caps-file 是 ${capsStaleMin} 分钟前的快照（阈值 ${CAPS_FILE_TTL_MS / 60000} 分钟）：canRunChildTask、模型清单与选项取值可能已过期——重新调 orchestrator_capabilities 落盘后再选；无法刷新时去掉 --caps-file 走 ~/.t3/caches 降级判断`,
        );
      }
    } catch {}
    return { providers, warnings, live: true, capsStaleMin };
  }
  const cacheDir = process.env.T3_CACHE_DIR || join(homedir(), ".t3", "caches");
  const wanted = new Set();
  for (const m of Object.values(MODELS)) for (const e of m.entries) wanted.add(e.provider);
  for (const id of wanted) {
    if (id === "pi") {
      providers.set(id, loadPiModels());
      continue;
    }
    const file = join(cacheDir, `${id}.json`);
    let c = null;
    try {
      c = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (!c) {
      providers.set(id, { runnable: false, reason: `无缓存文件 ${file}`, models: new Set(), optionSpecs: new Map(), optionIds: new Map() });
      continue;
    }
    const runnable = c.enabled === true && c.status === "ready" && c.auth?.status === "authenticated";
    const optionSpecs = new Map();
    for (const m of c.models ?? []) optionSpecs.set(m.slug ?? m.id, optionSpec(m.capabilities?.optionDescriptors));
    providers.set(id, {
      runnable,
      reason: runnable ? undefined : `缓存状态 enabled=${c.enabled} status=${c.status} auth=${c.auth?.status}`,
      models: new Set(optionSpecs.keys()),
      optionSpecs,
      optionIds: new Map([...optionSpecs].map(([k, v]) => [k, new Set(v.keys())])),
    });
  }
  warnings.push(
    "降级模式：未提供 --caps-file——pi 模型清单取自 `pi --list-models`，其余 provider 取自 ~/.t3/caches 快照，canRunChildTask 与选项取值均未验证。先调 orchestrator_capabilities 把返回 JSON 落盘并传 --caps-file 重跑；只有 MCP 工具确实不可用时才按本结果派发",
  );
  return { providers, warnings, live: false };
}

// pi 的实时模型清单：`pi --list-models` 表格（首行表头，列为 provider model ...），
// 入口 ID 取「provider/model」。不提供选项描述符，选项校验对 pi 入口放行（规格未知不误拦）。
function loadPiModels() {
  const bin = process.env.T3_PI_BIN || "pi";
  const r = spawnSync(bin, ["--list-models"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  const fail = (reason) => ({ runnable: false, reason, models: new Set(), optionSpecs: new Map(), optionIds: new Map() });
  if (r.error || r.status !== 0) return fail(`\`${bin} --list-models\` 失败：${r.error?.message ?? (r.stderr || `exit ${r.status}`).trim()}`);
  const models = new Set();
  for (const line of r.stdout.split("\n").slice(1)) {
    const [prov, model] = line.trim().split(/\s+/);
    if (prov && model) models.add(`${prov}/${model}`);
  }
  if (!models.size) return fail(`\`${bin} --list-models\` 未列出任何模型`);
  return { runnable: true, models, optionSpecs: new Map(), optionIds: new Map() };
}

// ---------- 模型解析 ----------

// provider/model 具体组合 → MODELS 条目
function findModel(provider, id) {
  for (const [key, m] of Object.entries(MODELS)) {
    if (m.entries.some((e) => e.provider === provider && e.id === id)) return { key, ...m };
  }
  return null;
}

// 任意字符串（模型 key / label / 任一入口 id）→ MODELS 条目；用于 named
function resolveModel(query) {
  const q = String(query).toLowerCase();
  const hits = [];
  for (const [key, m] of Object.entries(MODELS)) {
    const ids = m.entries.map((e) => e.id.toLowerCase());
    if (key.toLowerCase() === q || m.label.toLowerCase() === q || ids.includes(q)) hits.push({ key, ...m, exact: true });
    else if (key.toLowerCase().includes(q) || ids.some((i) => i.includes(q)) || m.label.toLowerCase().includes(q))
      hits.push({ key, ...m, exact: false });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return hits;
}

// ---------- 选项注入与硬性校验 ----------

function injectOptions(entry, providers) {
  const options = { ...(entry.options ?? {}) };
  const info = providers.get(entry.provider);
  if (entry.provider === "acpRegistry_factory_droid" && options.autonomy_level === undefined) {
    options.autonomy_level = PROVIDER_RULES.acpRegistry_factory_droid.forceOptions.autonomy_level;
  }
  // fastMode 只在该模型目录规格里确实存在时注入；规格未知不猜（曾因正则兜底给没有
  // fastMode 的 cursor/claudeAgent 模型注入，被服务端拒掉）
  const specHasFast = info?.optionSpecs.get(entry.id)?.has("fastMode") ?? false;
  if (specHasFast && options.fastMode === undefined) options.fastMode = false;
  return options;
}

// 校验 options 是否「目录可查 + 取值合法」。返回问题描述数组；
// 该模型规格未知（provider/模型不在目录里）时返回 []，不误拦。
function validateOptions(provider, modelId, options = {}, providers) {
  const specs = providers?.get(provider)?.optionSpecs.get(modelId);
  if (!specs) return [];
  const problems = [];
  for (const [k, v] of Object.entries(options)) {
    const spec = specs.get(k);
    if (!spec) {
      problems.push(`${provider}/${modelId} 无选项 ${k}（可用: ${[...specs.keys()].join(", ") || "无"}）`);
      continue;
    }
    if (spec.type === "boolean") {
      if (typeof v !== "boolean") problems.push(`${provider}/${modelId} 选项 ${k} 应为 boolean，实传 ${JSON.stringify(v)}`);
      continue;
    }
    if (spec.values?.size) {
      if (!spec.values.has(String(v))) {
        problems.push(`${provider}/${modelId} 选项 ${k} 非法取值 ${JSON.stringify(v)}（允许: ${[...spec.values].join(", ")}）`);
      }
    }
  }
  return problems;
}

// harness 白名单（PROVIDER_RULES.allowModels）：硬性规则，用户点名也不豁免。
function allowlistViolations(provider, model) {
  const reasons = [];
  const rule = PROVIDER_RULES[provider];
  if (rule?.allowModels && !rule.allowModels.includes(model)) reasons.push(`${provider} 只允许 ${rule.allowModels.join(" / ")}（${rule.note}）`);
  return reasons;
}

// MODELS.tasks 限定：模型不承担该任务类型时返回原因，否则 null
function taskViolation(modelKey, task) {
  const tasks = MODELS[modelKey]?.tasks;
  if (!tasks || !task || tasks.includes(task)) return null;
  return `${MODELS[modelKey].label} 只承担 ${tasks.join(" / ")} 任务，不做 ${task}`;
}

// check 子命令用的全部硬性规则；select 对生成的组合也跑一遍兜底。
// providers 可选：传了才做目录取值校验（check --caps-file），不传维持原有行为。
function gateCheck({ provider, model, role, options = {}, userNamed = false }, providers) {
  const fails = [];
  const warns = [];
  const resolved = findModel(provider, model);
  const status = resolved?.status;

  // 永远生效：快速模式、harness 白名单、droid 选项
  if (options.fastMode === true || options.fastMode === "true") fails.push("fastMode 必须为 false");
  if (options.serviceTier === "priority") fails.push("codex serviceTier 保持 default，不用 priority");
  if (/-fast\b/i.test(model)) fails.push(`模型名带 -fast（${model}）`);
  fails.push(...allowlistViolations(provider, model));
  if (provider === "acpRegistry_factory_droid") {
    if (options.autonomy_level === undefined) fails.push('factory_droid 任务 options 必须带 {"autonomy_level":"auto-high"}');
    else if (options.autonomy_level !== "auto-high") warns.push(`autonomy_level=${options.autonomy_level}，非 auto-high——确认是用户指定`);
    if (options.reasoningEffort !== undefined) fails.push("factory_droid 推理档选项名是 reasoning_effort（snake_case），不是 reasoningEffort");
  }

  if (providers) fails.push(...validateOptions(provider, model, options, providers));

  const roleTask = resolved && taskViolation(resolved.key, TASKS[role] ? role : undefined);
  if (!userNamed) {
    if (status === "named") fails.push(`${resolved.label} 仅限用户点名才可用，自动调度与换路跳过`);
    if (status === "advisor" && role === "implementation") fails.push(`${resolved.label} 是顾问/审查专用，不承担 implementation 任务`);
    if (roleTask) fails.push(`${roleTask}（role=${role}）`);
    if (!resolved) fails.push(`${provider}/${model} 不在生效路由数据任何模型的入口清单内，自动调度不得选用`);
  } else {
    if (status === "named") warns.push(`${resolved.label} 为点名专用模型——本次按用户点名放行`);
    if (resolved?.status === "advisor" && role === "implementation") warns.push(`${resolved.label} 平时不写实现；用户点名时按用户说的`);
    if (roleTask) warns.push(`${roleTask}；用户点名时按用户说的`);
    if (!resolved) warns.push(`${provider}/${model} 不在任何已知入口清单——确认模型 ID 与用户点名一致`);
  }
  return { fails, warns, resolved };
}

// ---------- 候选展开 ----------

// 候选 → 入口组合：{model, provider} 钉到该模型 entries 里 provider 匹配的条目（同一 harness 有多个入口时按 entries 顺序全部展开）；
// 不带 provider 的候选（白名单递补、named）展开该模型全部入口，entries 顺序即 harness 优先级。
function expandCandidates(cands, stream, seen, via) {
  for (const cand of cands) {
    const m = MODELS[cand.model];
    if (!m) continue;
    const entries = cand.provider ? m.entries.filter((e) => e.provider === cand.provider) : m.entries;
    entries.forEach((e, i) => {
      const k = entryId(e);
      if (seen.has(k)) return;
      seen.add(k);
      stream.push({
        model: cand.model,
        status: m.status,
        vision: m.vision ?? 0,
        provider: e.provider,
        id: e.id,
        options: { ...(e.options ?? {}), ...(i === 0 ? (cand.options ?? {}) : {}) },
        via: i === 0 ? (cand.via ?? via) : "same-model",
      });
    });
  }
}

// 白名单递补：ROUTES 行内没点名的可调度模型按 MODELS 声明顺序补在流末尾。
// status:"auto" 全任务可用；"advisor" 只进 ADVISOR_TASKS 任务；named 不进自动调度流；
// 带 tasks 的模型只进所列任务。
function whitelistCands(taskKey) {
  const allowAdvisor = ADVISOR_TASKS.includes(taskKey);
  return Object.keys(MODELS)
    .filter((k) => MODELS[k].status === "auto" || (allowAdvisor && MODELS[k].status === "advisor"))
    .filter((k) => !taskViolation(k, taskKey))
    .map((model) => ({ model }));
}

function expandRoute(taskKey) {
  const stream = [];
  const seen = new Set();
  expandCandidates(ROUTES[taskKey] ?? [], stream, seen, "route");
  expandCandidates(whitelistCands(taskKey), stream, seen, "whitelist");
  return stream;
}

// ---------- select ----------

function buildContext(opts) {
  const { providers, warnings, capsStaleMin } = loadProviders(opts["caps-file"]);
  return { providers, capsStaleMin, warnings: [...CONFIG_NOTES, ...warnings] };
}

// 目录可派性：实例在清单、可派子任务、模型清单有此 ID。caps 快照过期时逐条标注，逼出复核。
function catalogReasons(item, ctx) {
  const staleNote = ctx.capsStaleMin !== undefined ? `；caps 快照 ${ctx.capsStaleMin} 分钟前生成，此判定可能已过期` : "";
  const info = ctx.providers.get(item.provider);
  if (!info) return [`实例不在 capabilities/缓存清单${staleNote}`];
  if (!info.runnable) return [`实例不可派子任务${info.reason ? `（${info.reason}）` : ""}${staleNote}`];
  if (!info.models.has(item.id)) return [`该实例模型清单无此 ID${staleNote}`];
  return [];
}

function gateEntry(item, ctx, opts, taskKey) {
  const reasons = [];
  if (item.status === "named") reasons.push("仅限用户点名");
  // 兜底：白名单递补已按任务过滤，这里再拦一次行内错配的顾问模型
  if (item.status === "advisor" && taskKey && !ADVISOR_TASKS.includes(taskKey)) reasons.push("顾问模型不承担该任务类型");
  const tv = taskViolation(item.model, taskKey);
  if (tv) reasons.push(tv);
  reasons.push(...allowlistViolations(item.provider, item.id));
  reasons.push(...catalogReasons(item, ctx));
  // 注入后的最终 options 过一遍目录校验（选项名/取值非法的入口直接跳过）
  reasons.push(...validateOptions(item.provider, item.id, injectOptions(item, ctx.providers), ctx.providers));
  return reasons;
}

function finalize(item, ctx) {
  return {
    providerInstanceId: item.provider,
    model: item.id,
    modelKey: item.model,
    options: injectOptions(item, ctx.providers),
    via: item.via,
  };
}

// --exclude-model 取值：MODELS key，或任一入口的 provider/id（换算成所属模型）；无法识别返回 null
function excludeModelKey(v) {
  if (MODELS[v]) return v;
  const slash = String(v).indexOf("/");
  return slash > 0 ? (findModel(v.slice(0, slash), v.slice(slash + 1))?.key ?? null) : null;
}

function runSelect(taskKey, ctx, opts, out) {
  let stream = expandRoute(taskKey);
  const excluded = new Set(opts.exclude);
  const excludedModels = new Set(opts.excludeModel.map(excludeModelKey));
  const excludedProviders = new Set(opts.excludeProvider);
  stream = stream.filter((i) => !excluded.has(entryId(i)) && !excludedModels.has(i.model) && !excludedProviders.has(i.provider));

  if (opts.vision) {
    stream = [...stream].sort((a, b) => b.vision - a.vision);
    out.notes.push("--vision：候选按视觉分数降序");
  }

  const available = [];
  for (const item of stream) {
    const reasons = gateEntry(item, ctx, opts, taskKey);
    if (reasons.length) out.skipped.push({ entry: entryId(item), model: item.model, via: item.via, reasons });
    else available.push(finalize(item, ctx));
  }
  return available;
}

function selectCmd(opts) {
  const task = opts.task;
  if (task === "advisor") {
    console.error("--task advisor 已改名：审查用 --task review");
    process.exit(2);
  }
  if (!task || !TASKS[task]) {
    console.error(`--task 必填且须为: ${Object.keys(TASKS).join(" | ")}`);
    process.exit(2);
  }
  const badModels = opts.excludeModel.filter((v) => !excludeModelKey(v));
  if (badModels.length) {
    console.error(`--exclude-model 无法识别: ${badModels.join(", ")}（取模型 key 或入口 provider/model；模型 key: ${Object.keys(MODELS).join(", ")}）`);
    process.exit(2);
  }
  // --exclude-model 是「换个模型」的选型约束，不计入换路上限；--exclude-provider 是整个 harness
  // 故障后的一次换路（如 cliproxyapi 宕机），每个计一次
  const tried = opts.exclude.length + opts.excludeProvider.length;
  const out = { task, attempt: 1 + tried, pick: null, alternatives: [], skipped: [], notes: [], warnings: [] };
  if (out.attempt > MAX_ATTEMPTS) {
    out.error = `已试 ${tried} 个入口/harness，超过单任务 ${MAX_ATTEMPTS} 次上限——停下向用户报告每次尝试的入口和失败原因`;
    printSelect(out, opts);
    process.exit(1);
  }
  const ctx = buildContext(opts);
  out.warnings.push(...ctx.warnings);

  const available = runSelect(task, ctx, opts, out);
  out.pick = available[0] ?? null;
  out.alternatives = available.slice(1, 8);

  if (out.pick?.via === "whitelist") out.notes.push("PICK 来自白名单递补：路由行的候选都不可用（见 SKIPPED），该模型不在本任务优先级行内");
  printSelect(out, opts);
  process.exit(out.pick ? 0 : 1);
}

function printSelect(out, opts) {
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const fmt = (p) => (p ? `${p.providerInstanceId} / ${p.model}  model=${p.modelKey}  options=${JSON.stringify(p.options)}` : "无");
  for (const n of out.notes) console.log(`# ${n}`);
  for (const w of out.warnings) console.log(`WARN ${w}`);
  if (out.error) console.log(`ERROR ${out.error}`);
  console.log(`PICK ${fmt(out.pick)}`);
  if (!out.pick) console.log("无可用候选——见下方 skipped；不要再自行挑选");
  if (out.alternatives?.length) {
    console.log("ALTERNATIVES（按换路顺序）:");
    for (const a of out.alternatives) console.log(`  - ${fmt(a)}  via=${a.via}`);
  }
  if (out.skipped?.length) {
    console.log("SKIPPED:");
    for (const s of out.skipped) console.log(`  - ${s.entry} [${s.via ?? ""}] ${s.reasons.join("；")}`);
  }
}

// ---------- named ----------

function namedCmd(opts) {
  const query = opts._;
  if (!query) {
    console.error("用法: route.mjs named <模型> [--provider <id>] [--caps-file <path>] [--json]");
    process.exit(2);
  }
  const hits = resolveModel(query);
  if (!hits.length) {
    console.error(`无法识别模型 "${query}"。已知模型: ${Object.values(MODELS).map((m) => m.label).join("、")}`);
    console.error("用户点名清单外模型时，用 route.mjs check --user-named 验证后再手工指定 target。");
    process.exit(2);
  }
  const m = hits[0];
  const out = { named: m.label, status: m.status, pick: null, alternatives: [], skipped: [], warnings: [], notes: [] };
  if (m.status !== "named") out.warnings.push(`${m.label} 状态是 ${m.status}，不是点名专用——确认用户确实点名了它`);
  let entries = m.entries;
  if (opts.provider) entries = entries.filter((e) => e.provider === opts.provider);
  if (!entries.length) {
    console.error(`${m.label} 在 ${opts.provider} 上没有入口`);
    process.exit(2);
  }
  const ctx = buildContext(opts);
  out.warnings.push(...ctx.warnings);
  let extraOptions = {};
  if (opts.options) {
    try {
      extraOptions = JSON.parse(opts.options);
    } catch {
      console.error("--options 不是合法 JSON");
      process.exit(2);
    }
  }
  const avail = [];
  for (const e of entries) {
    const item = { model: m.key ?? query, status: m.status, vision: m.vision ?? 0, provider: e.provider, id: e.id, options: { ...(e.options ?? {}), ...extraOptions }, via: "named" };
    const reasons = [...allowlistViolations(item.provider, item.id), ...catalogReasons(item, ctx)];
    if (reasons.length) out.skipped.push({ entry: entryId(item), reasons });
    else avail.push(finalize(item, ctx));
  }
  out.pick = avail[0] ?? null;
  out.alternatives = avail.slice(1);
  printSelect(out, opts);
  process.exit(out.pick ? 0 : 1);
}

// ---------- check ----------

function checkCmd(opts) {
  const provider = opts.provider;
  const model = opts.model;
  if (!provider || !model) {
    console.error("用法: route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]");
    process.exit(2);
  }
  let options = {};
  if (opts.options) {
    try {
      const v = JSON.parse(opts.options);
      options = Array.isArray(v) ? Object.fromEntries(v.map((i) => [i.id, i.value])) : v;
    } catch {
      console.error("--options 不是合法 JSON");
      process.exit(2);
    }
  }
  const { providers, warnings: capsWarnings } = opts["caps-file"] ? loadProviders(opts["caps-file"]) : { providers: undefined, warnings: [] };
  for (const w of [...CONFIG_NOTES, ...capsWarnings]) console.log(`WARN ${w}`);
  const { fails, warns } = gateCheck({ provider, model, role: opts.role, options, userNamed: opts["user-named"] }, providers);
  for (const w of warns) console.log(`WARN ${w}`);
  if (fails.length) {
    console.log(`FAIL ${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}`);
    for (const f of fails) console.log(`- ${f}`);
    process.exit(1);
  }
  console.log(`OK ${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}${opts["user-named"] ? " (user-named)" : ""}`);
}

// ---------- audit ----------

// 审计生效路由数据：全部 MODELS entries 与 ROUTES 候选的「入口 options + 行内 options」
// 合并结果，逐条核对 provider/模型在目录里、选项名与取值合法。返回问题描述数组。
function auditRouteData(providers) {
  const problems = [];
  const check = (label, provider, modelId, options) => {
    const info = providers.get(provider);
    if (!info) {
      problems.push(`${label}: ${provider} 不在目录`);
      return;
    }
    if (!info.models.has(modelId)) {
      problems.push(`${label}: ${provider}/${modelId} 不在该实例模型清单`);
      return;
    }
    // 校验注入后的最终 options（覆盖 fastMode 自动注入、行内覆盖）
    const finalOptions = injectOptions({ provider, id: modelId, options }, providers);
    for (const p of validateOptions(provider, modelId, finalOptions, providers)) problems.push(`${label}: ${p}`);
  };
  for (const [key, m] of Object.entries(MODELS)) {
    for (const e of m.entries) check(`MODELS.${key}`, e.provider, e.id, e.options ?? {});
  }
  for (const [task, cands] of Object.entries(ROUTES)) {
    for (const c of cands) {
      const m = MODELS[c.model];
      if (!m) {
        problems.push(`ROUTES.${task}: 未知模型 ${c.model}`);
        continue;
      }
      if (!c.provider) {
        problems.push(`ROUTES.${task}: ${c.model} 候选缺 provider（组合须显式钉 harness）`);
        continue;
      }
      const e = m.entries.find((x) => x.provider === c.provider);
      if (!e) {
        problems.push(`ROUTES.${task}: ${c.model} 没有 ${c.provider} 入口`);
        continue;
      }
      const tv = taskViolation(c.model, task);
      if (tv) problems.push(`ROUTES.${task}: ${tv}`);
      check(`ROUTES.${task}`, e.provider, e.id, { ...(e.options ?? {}), ...(c.options ?? {}) });
    }
  }
  return problems;
}

function auditCmd(opts) {
  const { providers, warnings } = loadProviders(opts["caps-file"]);
  const problems = auditRouteData(providers);
  warnings.unshift(...CONFIG_NOTES);
  if (opts.json) {
    console.log(JSON.stringify({ problems, warnings }, null, 2));
  } else {
    for (const w of warnings) console.log(`WARN ${w}`);
    if (problems.length) for (const p of problems) console.log(`PROBLEM ${p}`);
    else console.log("audit: 0 问题，全部入口目录可查、选项合法");
  }
  process.exit(problems.length ? 1 : 0);
}

// ---------- table / tasks ----------

function tableCmd(opts) {
  const data = { CONFIG, PROVIDER_RULES, MODELS, TASKS, ADVISOR_TASKS, ROUTES, MAX_ATTEMPTS };
  console.log(opts.json ? JSON.stringify(data, null, 2) : renderTable(data));
}

function renderTable({ CONFIG: cfg, MODELS: ms, ROUTES: rs }) {
  const lines = [`配置来源：${cfg.source}`, ...CONFIG_NOTES.map((n) => `WARN ${n}`)];
  for (const [key, m] of Object.entries(ms)) {
    lines.push(`\n[${m.label}] status=${m.status}${m.tasks ? ` tasks=${m.tasks.join(",")}` : ""}${m.vision ? ` vision=${m.vision}` : ""}`);
    m.entries.forEach((e, i) => lines.push(`  ${i + 1}. ${e.provider} / ${e.id}  options=${JSON.stringify(e.options ?? {})}`));
  }
  lines.push("\nROUTES（行内是「模型@harness」组合的优先级；行尾自动递补白名单）:");
  for (const [task, cands] of Object.entries(rs)) {
    const tail = `auto${ADVISOR_TASKS.includes(task) ? "+advisor" : ""}`;
    lines.push(`  ${task}: ${cands.map((c) => `${c.model}@${c.provider}`).join("  →  ")}   ⇒ 递补:${tail}`);
  }
  return lines.join("\n");
}

// ---------- main ----------

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const KNOWN = new Set(["select", "named", "check", "audit", "table", "tasks"]);
  const [cmd, ...rest] = process.argv.slice(2);
  const isCmd = KNOWN.has(cmd);
  const opts = parseArgs(isCmd ? rest : process.argv.slice(2));
  try {
    if (cmd === "check") checkCmd(opts);
    else if (cmd === "audit") auditCmd(opts);
    else if (cmd === "named") namedCmd(opts);
    else if (cmd === "table") tableCmd(opts);
    else if (cmd === "tasks") {
      for (const [k, v] of Object.entries(TASKS)) console.log(`${k.padEnd(14)} ${v}`);
    } else {
      // 默认 select：route.mjs --task X 与 route.mjs select --task X 等价
      selectCmd(opts);
    }
  } catch (e) {
    console.error(e.stack ?? e.message);
    process.exit(2);
  }
}

export { gateCheck, allowlistViolations, expandRoute, expandCandidates, whitelistCands, loadProviders, resolveModel, findModel, validateOptions, injectOptions, auditRouteData };
