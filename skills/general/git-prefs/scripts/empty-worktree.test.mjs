#!/usr/bin/env node
// empty-worktree.mjs 夹具测试：临时目录造 git 仓库 + 链接工作树，
// 覆盖各拒绝分支与清空-注销流程，不碰真实仓库。
// 用法：node empty-worktree.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "empty-worktree.mjs");
const root = mkdtempSync(join(tmpdir(), "empty-wt-test-"));

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });
const run = (cwd, args = []) =>
  spawnSync("node", [script, ...args], { cwd, encoding: "utf8" });

let pass = 0;
let failN = 0;
const ok = (cond, msg) => {
  if (cond) pass++;
  else {
    failN++;
    console.error(`FAIL: ${msg}`);
  }
};

// 夹具：主仓库 + 一次提交
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
git(["init", "-q"], repo);
git(["config", "user.email", "t@t"], repo);
git(["config", "user.name", "t"], repo);
writeFileSync(join(repo, "f.txt"), "x");
git(["add", "."], repo);
git(["commit", "-qm", "init"], repo);

// 1. 非 git 目录拒绝
let r = run(root);
ok(r.status !== 0 && /不在 git 工作树内/.test(r.stderr), "非 git 目录应被拒绝");

// 2. 主检出拒绝
r = run(repo);
ok(r.status !== 0 && /主检出/.test(r.stderr), "主检出应被拒绝");

// 链接工作树
const wt = join(root, "wt");
git(["worktree", "add", "-q", "-b", "wt-branch", wt], repo);
writeFileSync(join(wt, "a.txt"), "a");
mkdirSync(join(wt, "sub"));
writeFileSync(join(wt, "sub", "b.txt"), "b");

// 3. 子目录 cwd 拒绝（会把自己的 cwd 删掉）
r = run(join(wt, "sub"));
ok(r.status !== 0 && /工作树根/.test(r.stderr), "子目录 cwd 应被拒绝");
ok(existsSync(join(wt, ".git")), "拒绝后 .git 仍在");

// 4. dry-run 不删除
r = run(wt, ["--dry-run"]);
ok(r.status === 0 && existsSync(join(wt, "a.txt")), "--dry-run 成功且不删除");

// 5. 真正清空
r = run(wt);
ok(r.status === 0, `清空应成功（stderr: ${r.stderr.trim()}）`);
ok(existsSync(wt), "目录壳保留");
ok(
  readdirSync(wt).join(",") === ".worktree-placeholder",
  `清空后只剩占位文件（实际：${readdirSync(wt).join(",")}）`,
);

// 6. 注册已注销、分支保留
const porcelain = git(["worktree", "list", "--porcelain"], repo);
ok((porcelain.match(/^worktree /gm) ?? []).length === 1, "worktree 注册已注销");
ok(
  git(["branch", "--list", "wt-branch"], repo).includes("wt-branch"),
  "本地分支保留待后续清理",
);

// 7. 清空后的空壳再跑一次——已非 git 目录，应被拒绝
r = run(wt);
ok(r.status !== 0, "空壳目录二次运行应被拒绝");

rmSync(root, { recursive: true, force: true });
console.log(`${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
