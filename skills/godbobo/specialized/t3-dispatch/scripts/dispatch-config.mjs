#!/usr/bin/env node
// 派活偏好：references/config.defaults.json 是默认值，用户在 ~/.config/bstack/t3-dispatch.json 只写要改的键。
//
// 用法：node dispatch-config.mjs
// 输出 { source, warnings, errors, config, environments }；配置文件损坏时 errors 非空、退出码 3，config 回落为默认值。
// 合并规则与 environments.json 的读取复用 t3-patrol（两者同属 bstack，安装时同级排布）。
//
// repos 每项：{ repo: <T3 项目的 canonicalKey>, source: "fast-ship", project?: <来源里的项目 ID>,
//              statuses?: [准入状态…], template?: <模板名>, devices?: [environments.json 别名…], baseRef?: <工作树起点分支，缺省 main> }

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, loadEnvironments, mergeConfig } from "../../t3-patrol/scripts/patrol-config.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULTS_PATH = join(SKILL_DIR, "references", "config.defaults.json");
export const CONFIG_FILE = "t3-dispatch.json";
export const MODES = ["off", "dry-run", "auto"];
export const SOURCES = { "fast-ship": { statuses: ["unset", "todo", "in_progress", "done"], defaultStatuses: ["unset", "todo"] } };
const RUNTIME = ["approval-required", "auto-accept-edits", "auto", "full-access"];

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isName = (v) => typeof v === "string" && /^[\w.-]+$/.test(v);

// 坏条目丢弃并报警告：拼错的仓库或状态静默生效，会把不该派的问题派出去。
export function validateRepos(repos, warnings = []) {
  const out = [];
  const seen = new Set();
  for (const [i, r] of (repos ?? []).entries()) {
    const at = `repos[${i}]`;
    if (kind(r) !== "object" || typeof r.repo !== "string" || !r.repo.includes("/")) {
      warnings.push(`${at}：须带完整 canonicalKey 的 repo（如 github.com/owner/name），已忽略`);
      continue;
    }
    const repo = r.repo.toLowerCase();
    const src = SOURCES[r.source];
    if (!src) {
      warnings.push(`${at}.source：应为 ${Object.keys(SOURCES).join(" / ")}，已忽略 ${r.repo}`);
      continue;
    }
    if (seen.has(repo)) {
      warnings.push(`${at}：${r.repo} 重复，已忽略`);
      continue;
    }
    const statuses = r.statuses ?? src.defaultStatuses;
    if (kind(statuses) !== "array" || !statuses.length || !statuses.every((s) => src.statuses.includes(s)) || statuses.includes("in_progress") || statuses.includes("done")) {
      warnings.push(`${at}.statuses：应为 ${src.defaultStatuses.join(" / ")} 中的非空子集，已忽略 ${r.repo}`);
      continue;
    }
    const bad = [
      r.project !== undefined && !(typeof r.project === "string" && r.project) && "project 应为字符串",
      r.template !== undefined && !isName(r.template) && "template 应为模板文件名（不含 .md）",
      r.devices !== undefined && !(kind(r.devices) === "array" && r.devices.length && r.devices.every((d) => typeof d === "string" && d)) && "devices 应为非空别名数组",
      r.baseRef !== undefined && !(typeof r.baseRef === "string" && r.baseRef.trim()) && "baseRef 应为分支名",
    ].filter(Boolean);
    if (bad.length) {
      warnings.push(`${at}：${bad.join("；")}，已忽略 ${r.repo}`);
      continue;
    }
    for (const k of Object.keys(r)) if (!["repo", "source", "project", "statuses", "template", "devices", "baseRef"].includes(k)) warnings.push(`${at}.${k}：未知字段，已忽略`);
    seen.add(repo);
    out.push({ repo, source: r.source, ...(r.project ? { project: r.project } : {}), statuses: [...statuses], template: r.template ?? "default", baseRef: r.baseRef?.trim() ?? "main", ...(r.devices ? { devices: [...r.devices] } : {}) });
  }
  return out;
}

export function loadConfig({ env = process.env, defaultsPath = DEFAULTS_PATH } = {}) {
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  const file = join(configDir(env), CONFIG_FILE);
  const finish = (r) => ({ ...r, config: { ...r.config, repos: validateRepos(r.config.repos, r.warnings) } });
  if (!existsSync(file)) return finish({ source: "defaults", warnings: [], errors: [], config: defaults });
  let user;
  try {
    user = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (kind(user) !== "object") throw new Error(`顶层应为对象，实际是 ${kind(user)}`);
  } catch (e) {
    return finish({ source: file, warnings: [], errors: [`无法解析：${e.message}；本轮使用默认值`], config: defaults });
  }
  const warnings = [];
  const { version, ...rest } = user;
  if (version !== undefined && !(Number.isInteger(version) && version <= defaults.version)) {
    warnings.push(`version：${JSON.stringify(version)} 不是本技能支持的版本（最高 ${defaults.version}），先更新技能`);
  }
  // model.options 的键随 harness 而变，整组替换，不按默认值的键校验。
  const { model, ...others } = rest;
  const { config } = mergeConfig(defaults, others, "", warnings);
  if (model !== undefined) {
    if (kind(model) === "object" && typeof model.instanceId === "string" && typeof model.model === "string" && (model.options === undefined || kind(model.options) === "object")) {
      config.model = { instanceId: model.instanceId, model: model.model, ...(model.options ? { options: model.options } : {}) };
    } else warnings.push("model：须带字符串 instanceId 与 model，options 为对象；沿用默认值");
  }
  if (!MODES.includes(config.mode)) {
    warnings.push(`mode：应为 ${MODES.join(" / ")}，沿用默认值 ${defaults.mode}`);
    config.mode = defaults.mode;
  }
  if (!RUNTIME.includes(config.runtimeMode)) {
    warnings.push(`runtimeMode：应为 ${RUNTIME.join(" / ")}，沿用默认值`);
    config.runtimeMode = defaults.runtimeMode;
  }
  for (const k of ["perRun", "perDay", "maxAttempts"]) {
    if (!(Number.isInteger(config.limits[k]) && config.limits[k] >= 0)) {
      warnings.push(`limits.${k}：应为非负整数，沿用默认值`);
      config.limits[k] = defaults.limits[k];
    }
  }
  if (!config.trustedUsers.every((u) => typeof u === "string")) {
    warnings.push("trustedUsers：应为字符串数组，沿用默认值");
    config.trustedUsers = defaults.trustedUsers;
  }
  return finish({ source: file, warnings, errors: [], config });
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = { ...loadConfig(), environments: loadEnvironments() };
  for (const repo of r.config.repos)
    for (const d of repo.devices ?? []) if (!r.environments.environments[d]) r.warnings.push(`repos：${repo.repo} 的设备 ${d} 不在 environments.json`);
  console.log(JSON.stringify(r, null, 2));
  if (r.errors.length) process.exit(3);
}
