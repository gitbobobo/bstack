#!/usr/bin/env node
// 列出已安装技能里带 references/setup.md 的技能，及其在 bstack 配置目录里的状态。
//
// 用法：node discover.mjs [--skills-dir <dir>]...
//   不传 --skills-dir 时扫描本技能所在目录、~/.agents/skills、~/.claude/skills，同名技能取先找到的。
// 输出 JSON { configDir, skills: [{ name, dir, setup, config, version, state, configVersion?, problem? }] }
//   state: unconfigured 无配置文件 | configured 已配置 | outdated 配置版本低于 setup.md
//          | newer 配置版本高于 setup.md（先更新技能）| broken 配置文件无法解析 | invalid setup.md 缺字段
// BSTACK_CONFIG_DIR 可改配置目录。
//
// setup.md 用 frontmatter 声明 `config: <配置目录内的文件名>` 与 `version: <整数>`。

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const configDir = (env = process.env) => env.BSTACK_CONFIG_DIR || join(homedir(), ".config", "bstack");

export const defaultSkillDirs = () => [dirname(SKILL_DIR), join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")];

export function parseFrontmatter(text) {
  const m = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*?)\s*$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function inspectSkill(name, dir, cfgDir) {
  const setup = join(dir, "references", "setup.md");
  const fm = parseFrontmatter(readFileSync(setup, "utf8"));
  const version = Number(fm.version);
  const base = { name, dir, setup, config: fm.config ?? null, version: Number.isInteger(version) ? version : null };
  if (!fm.config || !Number.isInteger(version)) return { ...base, state: "invalid", problem: "setup.md frontmatter 须有 config 与整数 version" };
  const file = join(cfgDir, fm.config);
  if (!existsSync(file)) return { ...base, state: "unconfigured" };
  let user;
  try {
    user = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { ...base, state: "broken", problem: `${file} 无法解析：${e.message}` };
  }
  const configVersion = Number.isInteger(user?.version) ? user.version : null;
  const state = configVersion === null || configVersion < version ? "outdated" : configVersion > version ? "newer" : "configured";
  return { ...base, state, configVersion };
}

export function discover({ skillDirs = defaultSkillDirs(), env = process.env } = {}) {
  const cfgDir = configDir(env);
  const seen = new Map();
  for (const root of skillDirs) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || seen.has(name)) continue;
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, "references", "setup.md"))) continue;
      } catch {
        continue;
      }
      seen.set(name, inspectSkill(name, dir, cfgDir));
    }
  }
  return { configDir: cfgDir, skills: [...seen.values()] };
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const dirs = args.flatMap((a, i) => (a === "--skills-dir" && args[i + 1] ? [args[i + 1]] : []));
  console.log(JSON.stringify(discover(dirs.length ? { skillDirs: dirs } : {}), null, 2));
}
