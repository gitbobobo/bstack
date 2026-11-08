#!/usr/bin/env node
// bstack 配置目录（默认 ~/.config/bstack，BSTACK_CONFIG_DIR 可改）的可选 git 同步。
// 技能只读目录里的文件，不关心它是不是仓库；目录不是仓库时 pull/commit 什么也不做。
//
// 用法：
//   config-repo.mjs status                         目录与仓库状态（ahead/behind 以上次 fetch 为准）
//   config-repo.mjs init --remote <url>            把本地目录建成仓库并推到空的远端
//   config-repo.mjs clone <url> [--backup-existing] 克隆到配置目录；目录非空时须带 --backup-existing，原目录改名为 <目录>.bak-<时间戳>
//   config-repo.mjs pull                           git pull --ff-only
//   config-repo.mjs commit -m <说明> [<路径>...]    pull --rebase → 暂存（缺省全部）→ 提交 → 推送
//
// 输出一行 JSON；退出码：0 成功或无需操作；1 git 操作失败；2 参数或前置条件不满足。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const configDir = (env = process.env) => env.BSTACK_CONFIG_DIR || join(homedir(), ".config", "bstack");

// 只在本机：凭据、暂停开关与运行状态（如派活台账）不跟随同步。
export const GITIGNORE = "secrets/\nPAUSE\nstate/\n";

// 已有 .gitignore 只补缺的行：老仓库在加入新的本机条目后，commit 的 add -A 不能把它们推上去。
export function ensureGitignore(dir) {
  const file = join(dir, ".gitignore");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE.split("\n").filter((l) => l && !have.has(l));
  if (missing.length) writeFileSync(file, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return missing;
}

// 远端 URL 可能带 token，输出前去掉 userinfo。
export const redact = (url) => url?.replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1") ?? null;

class Fail extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function git(dir, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Fail(1, `无法运行 git：${r.error.message}`);
  const out = { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  if (!allowFail && r.status !== 0) throw new Fail(1, `git ${args[0]} 失败：${redact(out.stderr || out.stdout)}`);
  return out;
}

// 只认目录本身是仓库根：~/.config 可能整个在 dotfiles 仓库里。比较 show-prefix 而非路径，避开 Windows 斜杠与 macOS /private 差异。
const isRepo = (dir) => {
  if (!existsSync(dir)) return false;
  const r = git(dir, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], { allowFail: true });
  return r.status === 0 && r.stdout === "true";
};
const upstream = (dir) => {
  const r = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
};

export function status(dir) {
  if (!existsSync(dir)) return { dir, exists: false, repo: false };
  if (!isRepo(dir)) return { dir, exists: true, repo: false, files: readdirSync(dir).filter((n) => !n.startsWith(".")).length };
  const remote = git(dir, ["remote", "get-url", "origin"], { allowFail: true });
  const up = upstream(dir);
  let ahead = null;
  let behind = null;
  if (up) {
    [behind, ahead] = git(dir, ["rev-list", "--left-right", "--count", `${up}...HEAD`]).stdout.split(/\s+/).map(Number);
  }
  const dirty = git(dir, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean);
  return {
    dir,
    exists: true,
    repo: true,
    branch: git(dir, ["branch", "--show-current"]).stdout || null,
    remote: remote.status === 0 ? redact(remote.stdout) : null,
    upstream: up,
    ahead,
    behind,
    dirty,
  };
}

export function init(dir, remoteUrl) {
  if (!remoteUrl) throw new Fail(2, "init 需要 --remote <url>");
  mkdirSync(dir, { recursive: true });
  if (isRepo(dir)) {
    if (git(dir, ["remote", "get-url", "origin"], { allowFail: true }).status === 0) throw new Fail(2, "已是带 origin 的仓库；同步用 pull / commit");
  } else {
    git(dir, ["init", "-b", "main"]);
  }
  ensureGitignore(dir);
  git(dir, ["add", "-A"]);
  if (git(dir, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0) git(dir, ["commit", "-m", "chore: initialize bstack config"]);
  git(dir, ["remote", "add", "origin", remoteUrl]);
  const branch = git(dir, ["branch", "--show-current"]).stdout;
  const push = git(dir, ["push", "-u", "origin", branch], { allowFail: true });
  if (push.status !== 0) {
    throw new Fail(1, `推送失败：${redact(push.stderr)}；远端已有内容时改用 clone --backup-existing`, { committed: true });
  }
  return { action: "init", branch, remote: redact(remoteUrl) };
}

export function clone(dir, remoteUrl, { backupExisting = false } = {}) {
  if (!remoteUrl) throw new Fail(2, "clone 需要 <url>");
  let backup = null;
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!backupExisting) throw new Fail(2, `${dir} 非空；确认后加 --backup-existing，原目录会改名保留`);
    backup = `${dir}.bak-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
    renameSync(dir, backup);
  }
  const r = spawnSync("git", ["clone", remoteUrl, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    if (backup && !existsSync(dir)) renameSync(backup, dir);
    throw new Fail(1, `克隆失败：${redact(r.stderr.trim())}`, { restored: Boolean(backup) });
  }
  return { action: "clone", remote: redact(remoteUrl), backup };
}

export function pull(dir) {
  if (!isRepo(dir)) return { action: "skip", reason: "not-a-repo" };
  if (!upstream(dir)) return { action: "skip", reason: "no-upstream" };
  const before = git(dir, ["rev-parse", "HEAD"]).stdout;
  const r = git(dir, ["pull", "--ff-only"], { allowFail: true });
  if (r.status !== 0) throw new Fail(1, `pull --ff-only 失败，沿用本地版本：${redact(r.stderr)}`);
  return { action: "pull", updated: git(dir, ["rev-parse", "HEAD"]).stdout !== before };
}

export function commit(dir, message, paths = []) {
  if (!message) throw new Fail(2, "commit 需要 -m <说明>");
  if (!isRepo(dir)) return { action: "skip", reason: "not-a-repo" };
  const up = upstream(dir);
  if (up) {
    const r = git(dir, ["pull", "--rebase", "--autostash"], { allowFail: true });
    if (r.status !== 0) {
      git(dir, ["rebase", "--abort"], { allowFail: true });
      throw new Fail(1, `pull --rebase 失败，本地改动未提交：${redact(r.stderr)}`);
    }
  }
  ensureGitignore(dir);
  git(dir, ["add", "-A", "--", ...(paths.length ? paths : ["."])]);
  const changed = git(dir, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0;
  if (changed) git(dir, ["commit", "-m", message]);
  if (!up) return { action: "commit", committed: changed, pushed: false, reason: "no-upstream" };
  const ahead = Number(git(dir, ["rev-list", "--count", `${up}..HEAD`]).stdout);
  if (!ahead) return { action: "commit", committed: changed, pushed: false };
  const push = git(dir, ["push"], { allowFail: true });
  if (push.status !== 0) throw new Fail(1, `推送失败，提交留在本地，下次 commit 会重推：${redact(push.stderr)}`, { committed: changed });
  return { action: "commit", committed: changed, pushed: true };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const dir = configDir();
  switch (cmd) {
    case "status":
      return status(dir);
    case "init":
      return init(dir, flag("--remote"));
    case "clone": {
      const backupExisting = rest.includes("--backup-existing");
      return clone(dir, rest.find((a) => !a.startsWith("--")), { backupExisting });
    }
    case "pull":
      return pull(dir);
    case "commit": {
      const message = flag("-m");
      return commit(dir, message, rest);
    }
    default:
      throw new Fail(2, "用法：config-repo.mjs status | init --remote <url> | clone <url> [--backup-existing] | pull | commit -m <说明> [<路径>...]");
  }
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify({ ok: true, ...main(process.argv.slice(2)) }));
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    console.log(JSON.stringify({ ok: false, error: e.message, ...e.extra }));
    process.exit(e.code);
  }
}
