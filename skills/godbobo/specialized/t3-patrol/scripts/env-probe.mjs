#!/usr/bin/env node
// 资源探测：在目标设备上量工作树所在磁盘的剩余空间，可选先回收再量。巡检把它派到远程环境，按回复的 JSON 重算容量。
//
// 用法：node env-probe.mjs [--reclaim] [--gc <t3-worktree-gc.mjs 路径>]
// 输出 { host, platform, path, diskFreeGB, diskTotalGB, reclaim? }。
// --reclaim 跑 t3-code 技能的 t3-worktree-gc.mjs --purge-build --apply：删已终结线程的孤儿工作树，
// 保留下来的工作树只清可重建的构建产物；reclaim 带回收前后的剩余空间、汇总行与失败行。
// 量的是 T3 工作树根（T3CODE_HOME/worktrees，缺省 ~/.t3/worktrees）所在的盘，目录不存在时退到主目录。

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statfsSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// 技能安装时同级排布（~/.agents/skills/<name>，仓库里同在 specialized/ 下）。
export const DEFAULT_GC = join(dirname(SKILL_DIR), "t3-code", "scripts", "t3-worktree-gc.mjs");

export function probePath(env = process.env) {
  const root = join(env.T3CODE_HOME || join(homedir(), ".t3"), "worktrees");
  return existsSync(root) ? root : homedir();
}

export function diskOf(path) {
  const s = statfsSync(path);
  const gb = (blocks) => Math.round(((blocks * s.bsize) / 1e9) * 10) / 10;
  return { diskFreeGB: gb(s.bavail), diskTotalGB: gb(s.blocks) };
}

// gc 只输出文字：留汇总行与失败行，逐目录结论太长，不进回复。
export function summarizeGc(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  return {
    summary: lines.filter((l) => /^(汇总|构建产物|在用工作树|扫描根)/.test(l)),
    failed: lines.filter((l) => /^failed\s/.test(l)).slice(0, 10),
  };
}

export function reclaim(gc, path) {
  if (!existsSync(gc)) return { ok: false, error: `找不到 ${gc}（先 npx skills update -g 装上 t3-code 技能）` };
  const before = diskOf(path).diskFreeGB;
  const r = spawnSync(process.execPath, [gc, "--purge-build", "--apply"], { encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const after = diskOf(path).diskFreeGB;
  return {
    ok: r.status === 0,
    exitCode: r.status,
    ...(r.error ? { error: String(r.error.message ?? r.error) } : {}),
    beforeGB: before,
    afterGB: after,
    freedGB: Math.round((after - before) * 10) / 10,
    ...summarizeGc(r.stdout),
    ...(r.status !== 0 && r.stderr ? { stderr: r.stderr.slice(-2000) } : {}),
  };
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let gc = DEFAULT_GC;
  let doReclaim = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reclaim") doReclaim = true;
    else if (args[i] === "--gc" && args[i + 1]) gc = args[++i];
    else {
      console.error("用法：node env-probe.mjs [--reclaim] [--gc <t3-worktree-gc.mjs 路径>]");
      process.exit(2);
    }
  }
  const path = probePath();
  const rec = doReclaim ? reclaim(gc, path) : null;
  console.log(JSON.stringify({ host: hostname(), platform: platform(), path, ...diskOf(path), ...(rec ? { reclaim: rec } : {}) }, null, 1));
  if (rec && !rec.ok) process.exit(1);
}
