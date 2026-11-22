// 生效路由数据 = route-data.mjs 的默认值 + ~/.config/bstack/t3-orchestrator.json 的用户偏好。
//
// 用户文件可写（都可省略）：
//   implementers / advisors  整组替换两类池（MODELS 的 key，顺序即优先级；同一模型不能两边都在，implementers 不能为空）
//   models.<key>             覆盖已有模型的 label / effort / entries；新 key 即新增模型，须三项齐全
//   maxAttempts              单任务换路上限
// PROVIDER_RULES 与 EFFORT_KEYS 是技能规则，不在配置里改。
// 不合法的部分记 warnings 并沿用默认值；文件损坏记 errors，整份回落默认值。BSTACK_CONFIG_DIR 可改配置目录。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as DEFAULTS from "./route-data.mjs";

export { PROVIDER_RULES, EFFORT_KEYS } from "./route-data.mjs";

export const CONFIG_FILE = "t3-orchestrator.json";
export const CONFIG_VERSION = 2;
const MODEL_KEYS = ["label", "effort", "entries"];

export const configDir = (env = process.env) => env.BSTACK_CONFIG_DIR || join(homedir(), ".config", "bstack");

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isEntry = (e) => kind(e) === "object" && typeof e.provider === "string" && typeof e.id === "string" && (e.options === undefined || kind(e.options) === "object");

function modelField(key, value) {
  if (key === "label" || key === "effort") return typeof value === "string" && value ? null : "应为非空字符串";
  if (key === "entries") return kind(value) === "array" && value.length && value.every(isEntry) ? null : "应为非空数组，每项带字符串 provider 与 id，options 为对象";
  return "未知字段，已忽略";
}

// 纯函数：便于测试，不读文件。
export function buildRouteData(user = {}, defaults = DEFAULTS) {
  const warnings = [];
  const MODELS = structuredClone(defaults.MODELS);
  let IMPLEMENTERS = [...defaults.IMPLEMENTERS];
  let ADVISORS = [...defaults.ADVISORS];
  let MAX_ATTEMPTS = defaults.MAX_ATTEMPTS;
  const { version, models, implementers, advisors, maxAttempts, ...rest } = user;

  for (const k of Object.keys(rest)) warnings.push(`${k}：未知配置项，已忽略`);
  if (version !== undefined && version !== CONFIG_VERSION) {
    warnings.push(`version：${JSON.stringify(version)} 与本技能配置版本 ${CONFIG_VERSION} 不符，按 references/setup.md 重新配置`);
  }

  if (models !== undefined && kind(models) !== "object") warnings.push("models：应为对象，已忽略");
  for (const [key, patch] of Object.entries(kind(models) === "object" ? models : {})) {
    if (kind(patch) !== "object") {
      warnings.push(`models.${key}：应为对象，已忽略`);
      continue;
    }
    const accepted = {};
    for (const [f, v] of Object.entries(patch)) {
      const problem = modelField(f, v);
      if (problem) warnings.push(`models.${key}.${f}：${problem}${MODEL_KEYS.includes(f) ? "，沿用默认值" : ""}`);
      else accepted[f] = structuredClone(v);
    }
    if (Object.hasOwn(MODELS, key)) Object.assign(MODELS[key], accepted);
    else {
      const missing = MODEL_KEYS.filter((f) => !Object.hasOwn(accepted, f));
      if (missing.length) warnings.push(`models.${key}：新增模型缺 ${missing.join("、")}，已忽略`);
      else MODELS[key] = accepted;
    }
  }

  const pool = (name, value, allowEmpty) => {
    if (value === undefined) return null;
    if (kind(value) !== "array" || (!allowEmpty && !value.length)) return warnings.push(`${name}：应为${allowEmpty ? "" : "非空"}数组，沿用默认值`), null;
    const unknown = value.filter((k) => !Object.hasOwn(MODELS, k));
    if (unknown.length) return warnings.push(`${name}：未知模型 ${unknown.join("、")}，沿用默认值`), null;
    return [...value];
  };
  IMPLEMENTERS = pool("implementers", implementers, false) ?? IMPLEMENTERS;
  ADVISORS = pool("advisors", advisors, true) ?? ADVISORS;
  const both = ADVISORS.filter((k) => IMPLEMENTERS.includes(k));
  if (both.length) {
    warnings.push(`advisors：${both.join("、")} 同时在实现池，已从顾问池移除`);
    ADVISORS = ADVISORS.filter((k) => !both.includes(k));
  }

  if (maxAttempts !== undefined) {
    if (Number.isInteger(maxAttempts) && maxAttempts > 0) MAX_ATTEMPTS = maxAttempts;
    else warnings.push("maxAttempts：应为正整数，沿用默认值");
  }
  return { MODELS, IMPLEMENTERS, ADVISORS, MAX_ATTEMPTS, warnings };
}

export function loadRouteConfig({ env = process.env } = {}) {
  const file = join(configDir(env), CONFIG_FILE);
  const fallback = (errors) => ({ source: file, errors, ...buildRouteData({}) });
  if (!existsSync(file)) return { source: "defaults", errors: [], ...buildRouteData({}) };
  let user;
  try {
    user = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return fallback([`无法解析：${e.message}；使用默认路由数据`]);
  }
  if (kind(user) !== "object") return fallback([`顶层应为对象，实际是 ${kind(user)}；使用默认路由数据`]);
  return { source: file, errors: [], ...buildRouteData(user) };
}

const LOADED = loadRouteConfig();
export const { MODELS, IMPLEMENTERS, ADVISORS, MAX_ATTEMPTS } = LOADED;
export const CONFIG = { source: LOADED.source, warnings: LOADED.warnings, errors: LOADED.errors };
// 供各子命令原样打印的提示：配置有问题时，选路结果仍可用但不是用户想要的那份。
export const CONFIG_NOTES = [...CONFIG.errors, ...CONFIG.warnings].map((m) => `配置 ${CONFIG.source}：${m}`);
