#!/usr/bin/env node
// 巡检偏好：references/config.defaults.json 是默认值，用户在 ~/.config/bstack/t3-patrol.json 只写要改的键。
//
// 用法：node patrol-config.mjs
// 输出生效配置 { source, warnings, errors, config }；配置文件损坏时 errors 非空、退出码 3，config 回落为默认值。
// BSTACK_CONFIG_DIR 可改配置目录（测试与多套配置用）。

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULTS_PATH = join(SKILL_DIR, "references", "config.defaults.json");
export const CONFIG_FILE = "t3-patrol.json";

export const configDir = (env = process.env) => env.BSTACK_CONFIG_DIR || join(homedir(), ".config", "bstack");

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// 只接受默认值里已有的键且类型相同：拼错的键或错类型静默生效，比报警告危险得多。对象逐键合并，数组整体替换。
export function mergeConfig(defaults, user, path = "", warnings = []) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(user ?? {})) {
    const p = path ? `${path}.${k}` : k;
    if (!Object.hasOwn(defaults, k)) {
      warnings.push(`${p}：未知配置项，已忽略`);
      continue;
    }
    const want = kind(defaults[k]);
    if (kind(v) !== want) {
      warnings.push(`${p}：应为 ${want}，实际是 ${kind(v)}，沿用默认值`);
      continue;
    }
    out[k] = want === "object" ? mergeConfig(defaults[k], v, p, warnings).config : v;
  }
  return { config: out, warnings };
}

const validTier = (t) => kind(t) === "object" && typeof t.instanceId === "string" && typeof t.model === "string";

export function loadConfig({ env = process.env, defaultsPath = DEFAULTS_PATH } = {}) {
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  const file = join(configDir(env), CONFIG_FILE);
  if (!existsSync(file)) return { source: "defaults", warnings: [], errors: [], config: defaults };

  let user;
  try {
    user = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { source: file, warnings: [], errors: [`无法解析：${e.message}；本轮使用默认值`], config: defaults };
  }
  if (kind(user) !== "object") {
    return { source: file, warnings: [], errors: [`顶层应为对象，实际是 ${kind(user)}；本轮使用默认值`], config: defaults };
  }

  const warnings = [];
  const { version, ...rest } = user;
  if (version !== undefined && !(Number.isInteger(version) && version <= defaults.version)) {
    warnings.push(`version：${JSON.stringify(version)} 不是本技能支持的版本（最高 ${defaults.version}），先更新技能`);
  }
  const { config } = mergeConfig(defaults, rest, "", warnings);
  if (config.modelLadder !== defaults.modelLadder && !(config.modelLadder.length > 0 && config.modelLadder.every(validTier))) {
    warnings.push("modelLadder：每档须带字符串 instanceId 与 model，且至少一档；沿用默认阶梯");
    config.modelLadder = defaults.modelLadder;
  }
  return { source: file, warnings, errors: [], config };
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = loadConfig();
  console.log(JSON.stringify(r, null, 2));
  if (r.errors.length) process.exit(3);
}
