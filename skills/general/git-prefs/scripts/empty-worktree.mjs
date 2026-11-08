#!/usr/bin/env node
// 清空当前 git 链接工作树的全部内容，只保留目录壳（+ .worktree-placeholder）。
//
// 用途：用户明确要求删除当前所在的工作树时使用。直接删目录会让绑定它的
// 终端在命令运行前即失败且不可恢复（典型如 agent 会话 cwd），所以改成清空
// 内容、保留空壳维持 cwd，随后在主仓库 `worktree prune` 注销注册。空壳与
// 本地分支留给后续回收——写入 .worktree-placeholder 沿用「占位目录」约定，
// 便于清理工具识别空壳为可安全删除。
//
// 用法：cd <工作树根> && node empty-worktree.mjs [--dry-run]
//
// 拒绝执行的情形（任一）：
//   - cwd 不在 git 工作树内
//   - cwd 是仓库主检出而不是链接工作树（防呆底线，绝不误清主仓库）
//   - cwd 在工作树的子目录（清空会把终端 cwd 一起抹掉，先 cd 到根）
//
// 退出码：0 成功；1 拒绝执行或存在删除失败的条目。

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const USAGE = `用法：node empty-worktree.mjs [--dry-run]
  --dry-run   只打印将删除的条目，不实际删除
  --help      打印本用法

清空当前 git 链接工作树的全部内容，只保留目录壳。必须在要清空的
工作树根目录下运行；主检出与子目录一律拒绝执行。`;

const fail = (msg) => {
  console.error(`拒绝执行：${msg}`);
  process.exit(1);
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--dry-run");
if (unknown.length > 0) fail(`未知参数：${unknown.join(" ")}（--help 查看用法）`);

const dryRun = args.includes("--dry-run");

const git = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};

const cwd = process.cwd();

const top = git(["rev-parse", "--show-toplevel"], cwd);
if (top === null) fail("当前目录不在 git 工作树内");
const topReal = realpathSync(top);

if (realpathSync(cwd) !== topReal) {
  fail(`cwd 不是工作树根（${topReal}）。先 cd 到根再跑——从子目录清空会把终端 cwd 一起删掉`);
}

const gitDirOut = git(["rev-parse", "--git-dir"], topReal);
if (gitDirOut === null) fail("git rev-parse --git-dir 失败");
const gitDir = realpathSync(resolve(topReal, gitDirOut));
// 链接工作树的 commondir 记录在 <gitDir>/commondir 文件里（内容形如 "../.."）；
// 主检出没有该文件，gitDir 即 commondir。以此区分，不依赖 rev-parse 的输出格式。
let commonDir = gitDir;
try {
  commonDir = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
} catch {}
if (commonDir === gitDir) fail("这是仓库主检出，不是链接工作树——只清链接工作树");

const branch =
  git(["symbolic-ref", "-q", "--short", "HEAD"], topReal) ??
  `(detached ${git(["rev-parse", "--short", "HEAD"], topReal)})`;

const entries = readdirSync(topReal);
console.log(`工作树：${topReal}`);
console.log(`分支：${branch}`);
console.log(`顶层条目：${entries.length} 个`);

if (dryRun) {
  const shown = entries.slice(0, 20);
  console.log(`[dry-run] 将删除：${shown.join("、")}${entries.length > shown.length ? ` 等 ${entries.length} 个` : ""}`);
  console.log("[dry-run] 之后写入 .worktree-placeholder，并在主仓库 worktree prune 注销");
  process.exit(0);
}

const failed = [];
for (const e of entries) {
  try {
    rmSync(join(topReal, e), { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    failed.push(`${e}（${err.code ?? err.message}）`);
  }
}

if (failed.length === 0) {
  // 占位文件自述 safe to delete，沿用「占位目录」约定，
  // 让清理工具能把空壳识别为可安全删除。
  writeFileSync(
    join(topReal, ".worktree-placeholder"),
    [
      `Emptied by git-prefs/scripts/empty-worktree.mjs at ${new Date().toISOString()}`,
      "All contents removed at user request; the empty directory is kept only to",
      "preserve a bound terminal cwd. Safe to delete once the owning thread settles.",
      "",
    ].join("\n"),
  );
}

// .git 已删，注册信息在主仓库侧变成 stale，直接 prune 注销（只动元数据）。
const pruned = git(["--git-dir", commonDir, "worktree", "prune"], topReal) !== null;

console.log(`已删除 ${entries.length - failed.length}/${entries.length} 个顶层条目`);
if (failed.length) {
  console.log(`删除失败 ${failed.length} 个：${failed.join("、")}`);
  console.log("占位文件未写入；修正占用后可重跑本脚本");
}
if (pruned) console.log("worktree 注册已注销（git worktree prune）");
else console.log("worktree prune 失败，注册残留——后续在仓库里重跑 git worktree prune 即可");
console.log(`目录壳保留：${topReal}`);
console.log(`本地分支 ${branch} 未动，空壳与分支留给后续清理`);

process.exit(failed.length ? 1 : 0);
