// 生效路由数据 = route-data.mjs 的默认值 + ~/.config/bstack/t3-orchestrator.json 的用户偏好。
// route.mjs 与 route-playground.mjs 都从这里取数据；route-data.mjs 保持为默认值，测试据它校验不变量。
//
// 用户文件可写（都可省略）：
//   models.<key>   覆盖已有模型的 status / tasks / entries / label / vision；新 key 即新增模型，须带 label、status、entries
//   routes.<task>  整行替换该任务的候选顺序，task 取 TASKS 的 key
//   maxAttempts    单任务换路上限
// PROVIDER_RULES、TASKS、ADVISOR_TASKS 与档位标准是技能规则，不在配置里改。
// 不合法的部分记 warnings 并沿用默认值；文件损坏记 errors，整份回落默认值。BSTACK_CONFIG_DIR 可改配置目录。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as DEFAULTS from "./route-data.mjs";

export { PROVIDER_RULES, TASKS, ADVISOR_TASKS } from "./route-data.mjs";

export const CONFIG_FILE = "t3-orchestrator.json";
export const CONFIG_VERSION = 1;
const STATUSES = ["auto", "advisor", "named"];
const MODEL_KEYS = ["label", "status", "tasks", "vision", "entries"];

export const configDir = (env = process.env) => env.BSTACK_CONFIG_DIR || join(homedir(), ".config", "bstack");

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isEntry = (e) => kind(e) === "object" && typeof e.provider === "string" && typeof e.id === "string" && (e.options === undefined || kind(e.options) === "object");

function modelField(key, value, path) {
  switch (key) {
    case "label":
      return typeof value === "string" ? null : `${path}：应为字符串`;
    case "status":
      return STATUSES.includes(value) ? null : `${path}：应为 ${STATUSES.join(" / ")}`;
    case "tasks":
      return kind(value) === "array" && value.length && value.every((t) => Object.hasOwn(DEFAULTS.TASKS, t))
        ? null
        : `${path}：应为非空数组，取值 ${Object.keys(DEFAULTS.TASKS).join(" / ")}`;
    case "vision":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path}：应为数字`;
    case "entries":
      return kind(value) === "array" && value.length && value.every(isEntry) ? null : `${path}：应为非空数组，每项带字符串 provider 与 id，options 为对象`;
    default:
      return `${path}：未知字段，已忽略`;
  }
}

// 纯函数：便于测试，不读文件。
export function buildRouteData(user = {}, defaults = DEFAULTS) {
  const warnings = [];
  const MODELS = structuredClone(defaults.MODELS);
  const ROUTES = structuredClone(defaults.ROUTES);
  let MAX_ATTEMPTS = defaults.MAX_ATTEMPTS;
  const { version, models, routes, maxAttempts, ...rest } = user;

  for (const k of Object.keys(rest)) warnings.push(`${k}：未知配置项，已忽略`);
  if (version !== undefined && !(Number.isInteger(version) && version <= CONFIG_VERSION)) {
    warnings.push(`version：${JSON.stringify(version)} 不是本技能支持的版本（最高 ${CONFIG_VERSION}），先更新技能`);
  }

  if (models !== undefined && kind(models) !== "object") warnings.push("models：应为对象，已忽略");
  for (const [key, patch] of Object.entries(kind(models) === "object" ? models : {})) {
    if (kind(patch) !== "object") {
      warnings.push(`models.${key}：应为对象，已忽略`);
      continue;
    }
    const isNew = !Object.hasOwn(MODELS, key);
    const accepted = {};
    for (const [f, v] of Object.entries(patch)) {
      const problem = MODEL_KEYS.includes(f) ? modelField(f, v, `models.${key}.${f}`) : `models.${key}.${f}：未知字段，已忽略`;
      if (problem) warnings.push(MODEL_KEYS.includes(f) ? `${problem}，沿用默认值` : problem);
      else accepted[f] = structuredClone(v);
    }
    if (isNew) {
      const missing = ["label", "status", "entries"].filter((f) => !Object.hasOwn(accepted, f));
      if (missing.length) {
        warnings.push(`models.${key}：新增模型缺 ${missing.join("、")}，已忽略`);
        continue;
      }
      MODELS[key] = accepted;
    } else {
      Object.assign(MODELS[key], accepted);
    }
  }

  if (routes !== undefined && kind(routes) !== "object") warnings.push("routes：应为对象，已忽略");
  for (const [task, row] of Object.entries(kind(routes) === "object" ? routes : {})) {
    if (!Object.hasOwn(DEFAULTS.TASKS, task)) {
      warnings.push(`routes.${task}：未知任务类型（可用 ${Object.keys(DEFAULTS.TASKS).join(" / ")}），已忽略`);
      continue;
    }
    const bad = kind(row) !== "array" || !row.length
      ? ["应为非空数组"]
      : row.flatMap((c, i) => {
          if (kind(c) !== "object" || typeof c.model !== "string" || typeof c.provider !== "string") return [`第 ${i + 1} 项须带字符串 model 与 provider`];
          if (!MODELS[c.model]) return [`第 ${i + 1} 项模型 ${c.model} 不存在`];
          if (!MODELS[c.model].entries.some((e) => e.provider === c.provider)) return [`第 ${i + 1} 项 ${c.model} 没有 ${c.provider} 入口`];
          if (c.options !== undefined && kind(c.options) !== "object") return [`第 ${i + 1} 项 options 应为对象`];
          return [];
        });
    if (bad.length) warnings.push(`routes.${task}：${bad.join("；")}，整行沿用默认值`);
    else ROUTES[task] = structuredClone(row);
  }

  if (maxAttempts !== undefined) {
    if (Number.isInteger(maxAttempts) && maxAttempts > 0) MAX_ATTEMPTS = maxAttempts;
    else warnings.push("maxAttempts：应为正整数，沿用默认值");
  }

  // 改了模型入口却沿用默认路由行时，行里可能引用已删掉的入口；select 会静默跳过，这里提醒。
  for (const [task, row] of Object.entries(ROUTES)) {
    for (const c of row) {
      if (!MODELS[c.model]?.entries.some((e) => e.provider === c.provider)) warnings.push(`routes.${task}：${c.model}@${c.provider} 不在生效入口里，select 会跳过它`);
    }
  }
  return { MODELS, ROUTES, MAX_ATTEMPTS, warnings };
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
export const { MODELS, ROUTES, MAX_ATTEMPTS } = LOADED;
export const CONFIG = { source: LOADED.source, warnings: LOADED.warnings, errors: LOADED.errors };
// 供各子命令原样打印的提示：配置有问题时，选路结果仍可用但不是用户想要的那份。
export const CONFIG_NOTES = [...CONFIG.errors, ...CONFIG.warnings].map((m) => `配置 ${CONFIG.source}：${m}`);
