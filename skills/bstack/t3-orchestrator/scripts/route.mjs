#!/usr/bin/env node
// 固定规则路由：实现池 / 顾问池 + 已试入口进去，delegate_task 的 target 出来。
// 规则来自 route-config.mjs（route-data.mjs 默认值 + 用户配置 ~/.config/bstack/t3-orchestrator.json）；
// 本文件只做展开与过滤，不含可调整的策略。
//
// 子命令：
//   route.mjs impl|advisor [--exclude <provider/model>]... [--exclude-provider <id>]...
//                          [--exclude-model <模型 key|provider/model>]... [--caps-file <path>] [--json]
//       impl    只出实现池；advisor 先出顾问池，用尽后从实现池递补
//       候选顺序：池内各模型的首选入口按模型优先级排完，再排各自的第二入口，依此类推
//   route.mjs named <模型> [--provider <id>] [--caps-file ...] [--json]   用户点名时用，不限池
//   route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named] [--caps-file ...]
//   route.mjs audit [--caps-file <path>]   全部入口「目录可查 + 取值合法」，有问题 exit 1
//   route.mjs table                       打印生效数据与配置来源
//
// 退出码：0 选出/校验通过；1 无可用候选或校验违规；2 参数错误。
//
// capabilities：--caps-file 传 orchestrator_capabilities 的 JSON；mtime 超 30 分钟告警并给「不可派」类判定标过期。
// 缺省为降级模式：pi 模型清单取自 `pi --list-models`（T3 不刷新 ~/.t3/caches/pi.json），
// 其余 provider 读 ${T3_CACHE_DIR:-~/.t3/caches}/<provider>.json，canRunChildTask 未验证。
// 额度不在这里判断：pi 入口由 cliproxyapi 自动路由，其余入口失败即换路。

import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROVIDER_RULES, EFFORT_KEYS, MODELS, IMPLEMENTERS, ADVISORS, MAX_ATTEMPTS, CONFIG, CONFIG_NOTES } from "./route-config.mjs";

const CAPS_FILE_TTL_MS = 30 * 60 * 1000;
const ADVISOR_ROLES = ["review", "design"];
const entryId = (e) => `${e.provider}/${e.id}`;

function parseArgs(argv) {
  const args = { exclude: [], excludeModel: [], excludeProvider: [] };
  const lists = { exclude: "exclude", "exclude-model": "excludeModel", "exclude-provider": "excludeProvider" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      (args._ ??= []).push(a);
      continue;
    }
    const key = a.slice(2);
    if (["json", "user-named"].includes(key)) args[key] = true;
    else if (lists[key]) args[lists[key]].push(argv[++i]);
    else args[key] = argv[++i];
  }
  return args;
}

// ---------- capabilities ----------

function optionSpec(descriptors) {
  const spec = new Map();
  for (const o of descriptors ?? []) spec.set(o.id, { type: o.type, values: o.options?.length ? new Set(o.options.map((v) => v.id)) : null });
  return spec;
}

const unavailable = (reason) => ({ runnable: false, reason, models: new Set(), optionSpecs: new Map() });

function loadProviders(capsFile) {
  const warnings = [];
  const providers = new Map();
  if (capsFile) {
    const caps = JSON.parse(readFileSync(capsFile, "utf8"));
    for (const p of Array.isArray(caps) ? caps : (caps.providers ?? [])) {
      const optionSpecs = new Map((p.models ?? []).map((m) => [m.id, optionSpec(m.options)]));
      providers.set(p.providerInstanceId, {
        runnable: p.canRunChildTask === true,
        reason: p.canRunChildTask ? undefined : (p.constraints ?? []).join("; ") || "canRunChildTask=false",
        models: new Set(optionSpecs.keys()),
        optionSpecs,
      });
    }
    let capsStaleMin;
    try {
      const ageMs = Date.now() - statSync(capsFile).mtimeMs;
      if (ageMs > CAPS_FILE_TTL_MS) {
        capsStaleMin = Math.round(ageMs / 60000);
        warnings.push(`--caps-file 是 ${capsStaleMin} 分钟前的快照：重新调 orchestrator_capabilities 落盘后再选`);
      }
    } catch {}
    return { providers, warnings, capsStaleMin };
  }
  const cacheDir = process.env.T3_CACHE_DIR || join(homedir(), ".t3", "caches");
  for (const id of new Set(Object.values(MODELS).flatMap((m) => m.entries.map((e) => e.provider)))) {
    if (id === "pi") {
      providers.set(id, loadPiModels());
      continue;
    }
    const file = join(cacheDir, `${id}.json`);
    let c;
    try {
      c = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      providers.set(id, unavailable(`无缓存文件 ${file}`));
      continue;
    }
    const runnable = c.enabled === true && c.status === "ready" && c.auth?.status === "authenticated";
    const optionSpecs = new Map((c.models ?? []).map((m) => [m.slug ?? m.id, optionSpec(m.capabilities?.optionDescriptors)]));
    providers.set(id, {
      runnable,
      reason: runnable ? undefined : `缓存状态 enabled=${c.enabled} status=${c.status} auth=${c.auth?.status}`,
      models: new Set(optionSpecs.keys()),
      optionSpecs,
    });
  }
  warnings.push("降级模式：未提供 --caps-file，可派性与选项取值未验证；先落盘 orchestrator_capabilities 再重跑，MCP 工具确实不可用时才按本结果派发");
  return { providers, warnings };
}

// `pi --list-models` 表格（首行表头，列为 provider model ...）；不提供选项描述符，选项校验对 pi 放行。
function loadPiModels() {
  const bin = process.env.T3_PI_BIN || "pi";
  const r = spawnSync(bin, ["--list-models"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return unavailable(`\`${bin} --list-models\` 失败：${r.error?.message ?? (r.stderr || `exit ${r.status}`).trim()}`);
  const models = new Set();
  for (const line of r.stdout.split("\n").slice(1)) {
    const [prov, model] = line.trim().split(/\s+/);
    if (prov && model) models.add(`${prov}/${model}`);
  }
  if (!models.size) return unavailable(`\`${bin} --list-models\` 未列出任何模型`);
  return { runnable: true, models, optionSpecs: new Map() };
}

// ---------- 模型与选项 ----------

function findModel(provider, id) {
  const key = Object.keys(MODELS).find((k) => MODELS[k].entries.some((e) => e.provider === provider && e.id === id));
  return key ? { key, ...MODELS[key] } : null;
}

function resolveModel(query) {
  const q = String(query).toLowerCase();
  const names = (k) => [k, MODELS[k].label, ...MODELS[k].entries.map((e) => e.id)].map((s) => s.toLowerCase());
  const keys = Object.keys(MODELS);
  return keys.find((k) => names(k).includes(q)) ?? keys.find((k) => names(k).some((n) => n.includes(q))) ?? null;
}

const poolOf = (key) => (IMPLEMENTERS.includes(key) ? "impl" : ADVISORS.includes(key) ? "advisor" : "named");

// 入口 options + 固定档位 + droid autonomy + 目录里有 fastMode 时的 false
function buildOptions(modelKey, entry, providers) {
  const options = { ...(entry.options ?? {}) };
  const effortKey = EFFORT_KEYS[entry.provider];
  if (effortKey && MODELS[modelKey]?.effort) options[effortKey] = MODELS[modelKey].effort;
  for (const [k, v] of Object.entries(PROVIDER_RULES[entry.provider]?.forceOptions ?? {})) options[k] ??= v;
  if (providers?.get(entry.provider)?.optionSpecs.get(entry.id)?.has("fastMode")) options.fastMode ??= false;
  return options;
}

// 规格未知（provider/模型不在目录）时返回 []，不误拦。
function validateOptions(provider, modelId, options, providers) {
  const specs = providers?.get(provider)?.optionSpecs.get(modelId);
  if (!specs) return [];
  const problems = [];
  for (const [k, v] of Object.entries(options)) {
    const spec = specs.get(k);
    if (!spec) problems.push(`${provider}/${modelId} 无选项 ${k}（可用: ${[...specs.keys()].join(", ") || "无"}）`);
    else if (spec.type === "boolean") typeof v !== "boolean" && problems.push(`${provider}/${modelId} 选项 ${k} 应为 boolean`);
    else if (spec.values?.size && !spec.values.has(String(v))) problems.push(`${provider}/${modelId} 选项 ${k} 非法取值 ${JSON.stringify(v)}（允许: ${[...spec.values].join(", ")}）`);
  }
  return problems;
}

function catalogReasons(provider, id, ctx) {
  const stale = ctx.capsStaleMin !== undefined ? "（caps 快照已过期，此判定可能失效）" : "";
  const info = ctx.providers.get(provider);
  if (!info) return [`实例不在 capabilities/缓存清单${stale}`];
  if (!info.runnable) return [`实例不可派子任务${info.reason ? `（${info.reason}）` : ""}${stale}`];
  if (!info.models.has(id)) return [`该实例模型清单无此 ID${stale}`];
  return [];
}

// ---------- check ----------

function gateCheck({ provider, model, role, options = {}, userNamed = false }, providers) {
  const fails = [];
  const warns = [];
  const resolved = findModel(provider, model);
  const soft = (msg) => (userNamed ? warns.push(`${msg}；用户点名时按用户说的`) : fails.push(msg));

  if (options.fastMode === true || options.fastMode === "true") fails.push("fastMode 必须为 false");
  if (options.serviceTier === "priority") fails.push("codex serviceTier 保持 default，不用 priority");
  if (/-fast\b/i.test(model)) fails.push(`模型名带 -fast（${model}）`);
  if (provider === "acpRegistry_factory_droid") {
    if (options.autonomy_level === undefined) fails.push('factory_droid 任务 options 必须带 {"autonomy_level":"auto-high"}');
    else if (options.autonomy_level !== "auto-high") warns.push(`autonomy_level=${options.autonomy_level}，非 auto-high——确认是用户指定`);
    if (options.reasoningEffort !== undefined) fails.push("factory_droid 推理档选项名是 reasoning_effort（snake_case），不是 reasoningEffort");
  }
  if (providers) fails.push(...validateOptions(provider, model, options, providers));

  if (!resolved) {
    soft(`${provider}/${model} 不在生效路由数据的入口清单`);
    return { fails, warns };
  }
  const pool = poolOf(resolved.key);
  if (pool === "named") soft(`${resolved.label} 仅限用户点名`);
  if (pool === "advisor" && role && !ADVISOR_ROLES.includes(role)) soft(`${resolved.label} 是顾问模型，只承担 ${ADVISOR_ROLES.join(" / ")}`);
  const effortKey = EFFORT_KEYS[provider];
  if (effortKey && options[effortKey] !== resolved.effort) soft(`${resolved.label} 思考强度固定为 ${effortKey}=${resolved.effort}，实传 ${JSON.stringify(options[effortKey])}`);
  return { fails, warns };
}

function checkCmd(opts) {
  const { provider, model } = opts;
  if (!provider || !model) usage("route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named] [--caps-file ...]");
  let options = {};
  try {
    const v = opts.options ? JSON.parse(opts.options) : {};
    options = Array.isArray(v) ? Object.fromEntries(v.map((i) => [i.id, i.value])) : v;
  } catch {
    usage("--options 不是合法 JSON");
  }
  const caps = opts["caps-file"] ? loadProviders(opts["caps-file"]) : { warnings: [] };
  const { fails, warns } = gateCheck({ provider, model, role: opts.role, options, userNamed: opts["user-named"] }, caps.providers);
  for (const w of [...CONFIG_NOTES, ...caps.warnings, ...warns]) console.log(`WARN ${w}`);
  const head = `${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}`;
  if (fails.length) {
    console.log(`FAIL ${head}`);
    for (const f of fails) console.log(`- ${f}`);
    process.exit(1);
  }
  console.log(`OK ${head}${opts["user-named"] ? " (user-named)" : ""}`);
}

// ---------- 选择 ----------

// 池内模型按「入口序号优先、模型优先级其次」交错展开：先排完各模型的首选入口，再排第二入口……
function expandPool(keys, via) {
  const items = [];
  const depth = Math.max(0, ...keys.map((k) => MODELS[k]?.entries.length ?? 0));
  for (let i = 0; i < depth; i++) {
    for (const k of keys) {
      const e = MODELS[k]?.entries[i];
      if (e) items.push({ modelKey: k, entry: e, via });
    }
  }
  return items;
}

function expandRoute(kind) {
  return kind === "impl" ? expandPool(IMPLEMENTERS, "impl") : [...expandPool(ADVISORS, "advisor"), ...expandPool(IMPLEMENTERS, "fallback")];
}

function excludeModelKey(v) {
  if (MODELS[v]) return v;
  const slash = String(v).indexOf("/");
  return slash > 0 ? (findModel(v.slice(0, slash), v.slice(slash + 1))?.key ?? null) : null;
}

function finalize(item, ctx) {
  const options = buildOptions(item.modelKey, item.entry, ctx.providers);
  const reasons = [...catalogReasons(item.entry.provider, item.entry.id, ctx), ...validateOptions(item.entry.provider, item.entry.id, options, ctx.providers)];
  return { modelKey: item.modelKey, via: item.via, entry: entryId(item.entry), target: { providerInstanceId: item.entry.provider, model: item.entry.id, options }, reasons };
}

function emit(out, opts) {
  if (opts.json) return console.log(JSON.stringify(out, null, 2));
  for (const w of out.warnings) console.log(`WARN ${w}`);
  if (out.error) console.log(`ERROR ${out.error}`);
  const skippedAhead = out.pick ? out.skipped.slice(0, out.skippedAhead) : out.skipped;
  for (const s of skippedAhead) console.log(`SKIPPED ${s.entry}：${s.reasons.join("；")}`);
  if (out.pick) {
    console.log(`PICK ${out.pick.modelKey} ${JSON.stringify(out.pick.target)}`);
    if (out.pick.via === "fallback") console.log("# 顾问池已用尽，PICK 取自实现池");
  } else if (!out.error) console.log("PICK 无——见 SKIPPED，不要自行挑选");
  if (out.next?.length) console.log(`NEXT ${out.next.map((n) => n.entry).join(" → ")}`);
}

function selectCmd(kind, opts) {
  const badModels = opts.excludeModel.filter((v) => !excludeModelKey(v));
  if (badModels.length) usage(`--exclude-model 无法识别: ${badModels.join(", ")}（模型 key: ${Object.keys(MODELS).join(", ")}）`);
  // --exclude-model 是「换个模型」的选型约束，不计入换路上限
  const tried = opts.exclude.length + opts.excludeProvider.length;
  const out = { kind, attempt: tried + 1, pick: null, next: [], skipped: [], warnings: [] };
  if (out.attempt > MAX_ATTEMPTS) {
    out.error = `已试 ${tried} 个入口/harness，超过单任务 ${MAX_ATTEMPTS} 次上限——停下向用户报告每次尝试的入口和失败原因`;
    emit(out, opts);
    process.exit(1);
  }
  const ctx = loadProviders(opts["caps-file"]);
  out.warnings.push(...CONFIG_NOTES, ...ctx.warnings);
  const excluded = new Set(opts.exclude);
  const excludedModels = new Set(opts.excludeModel.map(excludeModelKey));
  const items = expandRoute(kind)
    .filter((i) => !excluded.has(entryId(i.entry)) && !excludedModels.has(i.modelKey) && !opts.excludeProvider.includes(i.entry.provider))
    .map((i) => finalize(i, ctx));
  const available = items.filter((i) => !i.reasons.length);
  out.skipped = items.filter((i) => i.reasons.length);
  out.pick = available[0] ?? null;
  out.next = available.slice(1, 6);
  out.skippedAhead = out.pick ? out.skipped.filter((s) => items.indexOf(s) < items.indexOf(out.pick)).length : out.skipped.length;
  emit(out, opts);
  process.exit(out.pick ? 0 : 1);
}

function namedCmd(opts) {
  const query = opts._?.[1];
  if (!query) usage("route.mjs named <模型> [--provider <id>] [--caps-file <path>] [--json]");
  const key = resolveModel(query);
  if (!key) usage(`无法识别模型 "${query}"（已知: ${Object.values(MODELS).map((m) => m.label).join("、")}）；清单外模型先 check --user-named 再手工指定 target`);
  const entries = MODELS[key].entries.filter((e) => !opts.provider || e.provider === opts.provider);
  if (!entries.length) usage(`${MODELS[key].label} 在 ${opts.provider} 上没有入口`);
  const ctx = loadProviders(opts["caps-file"]);
  const items = entries.map((entry) => finalize({ modelKey: key, entry, via: "named" }, ctx));
  const available = items.filter((i) => !i.reasons.length);
  const out = { kind: "named", pick: available[0] ?? null, next: available.slice(1), skipped: items.filter((i) => i.reasons.length), warnings: [...CONFIG_NOTES, ...ctx.warnings] };
  out.skippedAhead = out.skipped.length;
  emit(out, opts);
  process.exit(out.pick ? 0 : 1);
}

// ---------- audit / table ----------

function auditRouteData(providers) {
  const problems = [];
  for (const [key, m] of Object.entries(MODELS)) {
    for (const e of m.entries) {
      const label = `${key} ${entryId(e)}`;
      const info = providers.get(e.provider);
      if (!info) problems.push(`${label}: ${e.provider} 不在目录`);
      else if (!info.models.has(e.id)) problems.push(`${label}: 不在该实例模型清单`);
      else for (const p of validateOptions(e.provider, e.id, buildOptions(key, e, providers), providers)) problems.push(`${label}: ${p}`);
      if (!EFFORT_KEYS[e.provider]) problems.push(`${label}: ${e.provider} 没有登记思考强度选项名（EFFORT_KEYS）`);
    }
  }
  return problems;
}

function auditCmd(opts) {
  const { providers, warnings } = loadProviders(opts["caps-file"]);
  const problems = auditRouteData(providers);
  for (const w of [...CONFIG_NOTES, ...warnings]) console.log(`WARN ${w}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  if (!problems.length) console.log("audit: 0 问题，全部入口目录可查、选项合法");
  process.exit(problems.length ? 1 : 0);
}

function tableCmd() {
  const lines = [`配置来源：${CONFIG.source}`, ...CONFIG_NOTES.map((n) => `WARN ${n}`)];
  const pools = [["实现池", IMPLEMENTERS], ["顾问池", ADVISORS], ["仅点名", Object.keys(MODELS).filter((k) => poolOf(k) === "named")]];
  for (const [name, keys] of pools) {
    lines.push(`\n${name}:`);
    for (const k of keys) lines.push(`  ${MODELS[k].label} effort=${MODELS[k].effort}  ${MODELS[k].entries.map(entryId).join(" → ")}`);
  }
  console.log(lines.join("\n"));
}

function usage(msg) {
  console.error(msg);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._?.[0];
  try {
    if (cmd === "impl" || cmd === "advisor") selectCmd(cmd, opts);
    else if (cmd === "named") namedCmd(opts);
    else if (cmd === "check") checkCmd(opts);
    else if (cmd === "audit") auditCmd(opts);
    else if (cmd === "table") tableCmd();
    else usage("用法: route.mjs impl|advisor|named|check|audit|table（select --task 已改为 impl / advisor）");
  } catch (e) {
    console.error(e.stack ?? e.message);
    process.exit(2);
  }
}

export { gateCheck, expandRoute, loadProviders, resolveModel, findModel, validateOptions, buildOptions, auditRouteData };
