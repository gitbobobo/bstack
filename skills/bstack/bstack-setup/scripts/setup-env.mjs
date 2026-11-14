#!/usr/bin/env node
// 把本技能 rules/AGENTS.md 链接为各 agent harness 的全局规则文件。
//
// 用法：node setup-env.mjs [--check] [--copy]
//   --check  只报告各目标状态，不做任何改动
//   --copy   不建符号链接，改为复制文件（Windows 无开发者模式/权限时用）
//
// 退出码：0 全部就位；2 存在待处理项或部分失败；1 环境错误。
//
// 已有非空文件会先备份成 <path>.bak-<时间戳> 再替换；符号链接已指向真源则跳过。
// 指向旧 setup-env 技能（本技能改名前）的链接直接改指真源，不备份。

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const IS_WIN = platform() === "win32";
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
const PI_DIR = process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi", "agent");

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../rules/AGENTS.md");
const LEGACY_SOURCE = /[\\/]setup-env[\\/]rules[\\/]AGENTS\.md$/;

// 各 harness 的全局规则文件路径。devin 文档同时会读 ~/.claude/CLAUDE.md，
// claudeAgent 也读它，一份文件覆盖两家。
const TARGETS = [
  {
    harness: "devin",
    path: IS_WIN ? join(APPDATA, "devin", "AGENTS.md") : join(HOME, ".config", "devin", "AGENTS.md"),
    cli: "devin",
  },
  {
    harness: "codex",
    path: join(HOME, ".codex", "AGENTS.md"),
    cli: "codex",
  },
  {
    harness: "claude / claudeAgent",
    path: join(HOME, ".claude", "CLAUDE.md"),
    cli: "claude",
  },
  {
    // pi 的全局上下文文件：<agent-dir>/AGENTS.md，agent-dir 可被 PI_CODING_AGENT_DIR 覆盖。
    harness: "pi",
    path: join(PI_DIR, "AGENTS.md"),
    cli: "pi",
  },
];

// 本机环境体检项：只报告不安装（本脚本边界不含装 CLI），缺失时给安装提示。
const TOOLS = [
  { name: "cargo-nextest", hint: "cargo install cargo-nextest --locked" },
];

const checkOnly = process.argv.includes("--check");
const useCopy = process.argv.includes("--copy") || IS_WIN;
const sourceReal = realpathSync(SOURCE);
const sourceText = readFileSync(SOURCE, "utf8");
const stamp = new Date()
  .toISOString()
  .replace(/\D/g, "");

const which = (cmd) => {
  try {
    return execFileSync(IS_WIN ? "where" : "which", [cmd], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
};

function cargoToolOutsidePath(name) {
  const roots = [...new Set([process.env.CARGO_HOME, join(HOME, ".cargo")].filter(Boolean))];
  for (const root of roots) {
    const path = join(root, "bin", `${name}${IS_WIN ? ".exe" : ""}`);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, IS_WIN ? constants.F_OK : constants.X_OK);
      return path;
    } catch {
      // 不可执行、悬空链接和不存在的候选均继续探测。
    }
  }
  return null;
}

// 返回 { state, detail }；state: linked | legacy | copy-current | copy-stale | foreign-empty | foreign | absent
function inspect(t) {
  const path = t.path;
  if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) return { state: "absent" };
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    const target = resolve(dirname(path), readlinkSync(path));
    let real = null;
    try {
      real = realpathSync(target);
    } catch {
      // 悬空链接：旧技能卸载后常见，下面按目标路径判断。
    }
    if (real === sourceReal) return { state: "linked" };
    if (LEGACY_SOURCE.test(target)) return { state: "legacy", detail: `旧 setup-env 链接 → ${target}` };
    return { state: "foreign", detail: real ? `符号链接指向 ${target}` : `悬空符号链接 → ${target}` };
  }
  const content = readFileSync(path, "utf8");
  if (content === sourceText) return { state: "copy-current" };
  return content.trim() === ""
    ? { state: "foreign-empty" }
    : { state: "foreign", detail: `已有 ${content.length} 字符的不同内容` };
}

function apply(t, state) {
  const path = t.path;
  mkdirSync(dirname(path), { recursive: true });
  let note = "";
  if (state === "foreign" || state === "foreign-empty") {
    const bak = `${path}.bak-${stamp}`;
    renameSync(path, bak);
    note = `备份到 ${bak}，`;
  } else if (state === "legacy") {
    unlinkSync(path);
  }
  if (useCopy) {
    writeFileSync(path, sourceText);
    return `${note}已写入`;
  }
  symlinkSync(SOURCE, path);
  return `${note}已链接`;
}

let pending = 0;
console.log(`真源：${SOURCE}`);
console.log(`模式：${checkOnly ? "check（只读）" : useCopy ? "copy" : "symlink"}\n`);

for (const t of TARGETS) {
  const cliPath = which(t.cli);
  const { state, detail } = inspect(t);
  const cliInfo = cliPath ? `cli: ${cliPath}` : `cli: 未安装（${t.cli}）`;
  let action = "";
  if (!checkOnly && state !== "linked" && state !== "copy-current") {
    try {
      action = ` → ${apply(t, state)}`;
    } catch (e) {
      action = ` → 失败：${e.message}`;
      pending++;
    }
    // 应用后复查
    if (!action.includes("失败")) {
      const post = inspect(t).state;
      if (!(useCopy ? post === "copy-current" : post === "linked")) {
        action += "（复查未生效）";
        pending++;
      }
    }
  } else if (state !== "linked" && state !== "copy-current") {
    pending++;
  }
  const label = { linked: "已链接", "copy-current": "副本一致", "copy-stale": "副本过期", absent: "缺失", legacy: "旧链接", foreign: "有别的内容", "foreign-empty": "空文件" }[state];
  console.log(`${label.padEnd(6)} ${t.harness.padEnd(20)} ${t.path}   ${cliInfo}${detail ? `（${detail}）` : ""}${action}`);
}

// ---- 本机工具体检：只报告不安装 ----
for (const t of TOOLS) {
  const p = which(t.name);
  if (p) {
    console.log(`已安装   tool:${t.name.padEnd(14)} ${p}`);
  } else {
    const installed = cargoToolOutsidePath(t.name);
    console.log(installed
      ? `PATH不可见 tool:${t.name.padEnd(14)} 已安装：${installed}；将 ${dirname(installed)} 加入实际代理启动环境的 PATH`
      : `未安装   tool:${t.name.padEnd(14)} ${t.hint}`);
  }
}

// ---- sccache：多工作树并行时共享 Rust 编译缓存。装了 sccache 才配置，没装只报告。
// 写 $CARGO_HOME/config.toml 的 [build] rustc-wrapper；已有其他 wrapper 不覆盖。
{
  const sccache = which("sccache");
  const cargoHome = process.env.CARGO_HOME || join(HOME, ".cargo");
  const cfg = join(cargoHome, "config.toml");
  const text = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  const m = text.match(/^\s*rustc-wrapper\s*=\s*"([^"]*)"/m);
  const envWrapper = process.env.RUSTC_WRAPPER;
  if (!sccache) {
    console.log(`未安装   cargo:sccache        多工作树共享 Rust 编译缓存需要它（brew install sccache / cargo install sccache --locked）`);
  } else if (envWrapper || m) {
    const w = envWrapper || m[1];
    console.log(/sccache/.test(w)
      ? `已配置   cargo:rustc-wrapper  ${w}${envWrapper ? "（RUSTC_WRAPPER）" : `（${cfg}）`}`
      : `其他     cargo:rustc-wrapper  ${w}（已有别的 wrapper，不覆盖）`);
  } else if (checkOnly) {
    pending++;
    console.log(`待处理   cargo:rustc-wrapper  未配置 sccache；去掉 --check 写入 ${cfg}`);
  } else {
    try {
      mkdirSync(cargoHome, { recursive: true });
      if (text) writeFileSync(`${cfg}.bak-${stamp}`, text);
      const line = 'rustc-wrapper = "sccache"';
      const next = /^\[build\]\s*$/m.test(text)
        ? text.replace(/^\[build\]\s*$/m, `[build]\n${line}`)
        : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}[build]\n${line}\n`;
      writeFileSync(cfg, next);
      console.log(`已配置   cargo:rustc-wrapper  sccache → ${cfg}${text ? `（原文件备份到 ${cfg}.bak-${stamp}）` : ""}`);
    } catch (e) {
      pending++;
      console.log(`失败     cargo:rustc-wrapper  ${e.message}`);
    }
  }
}

// ---- pi 的 bash：Windows 上只在 C 盘 Program Files 找 Git Bash，找不到就落到 PATH 上的
// System32\bash.exe（WSL）——WSL 里 git 读不了 Windows gitdir、没有 node，超时也杀不到
// Windows 子进程。只报告，不改 settings.json。
if (IS_WIN && which("pi")) {
  const settingsPath = join(PI_DIR, "settings.json");
  let shellPath;
  try {
    shellPath = JSON.parse(readFileSync(settingsPath, "utf8")).shellPath;
  } catch {
    // 没有或解析不了 settings.json 时按未配置处理。
  }
  const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const defaultBash = pf.map((d) => join(d, "Git", "bin", "bash.exe")).find((p) => existsSync(p));
  const gitExe = which("git");
  const gitBash = gitExe && join(dirname(gitExe), "..", "bin", "bash.exe");
  if (shellPath && existsSync(shellPath)) {
    console.log(`已配置   pi:shellPath         ${shellPath}`);
  } else if (defaultBash) {
    console.log(`默认     pi:shell             ${defaultBash}`);
  } else {
    pending++;
    console.log(
      `待处理   pi:shell             会落到 WSL bash；在 ${settingsPath} 设置 "shellPath"` +
        (gitBash && existsSync(gitBash) ? `: ${JSON.stringify(resolve(gitBash))}` : " 指向 Git Bash"),
    );
  }
}

console.log(
  pending === 0
    ? "\n全部就位。"
    : checkOnly
      ? `\n${pending} 个目标待处理；去掉 --check 执行。`
      : `\n${pending} 个目标处理失败，见上方输出。`,
);
process.exit(pending === 0 ? 0 : 2);
