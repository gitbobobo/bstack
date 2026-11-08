#!/usr/bin/env node
// 资源检查：重验证（全量构建、门禁、E2E）开跑前，量本机工作树所在盘的剩余空间与 CPU 繁忙度，给出能不能跑。
// 巡检只按名额派活，磁盘与负载由干活的线程在用到时自己看：它最清楚这一步要多少空间。
//
// 用法：node resource-check.mjs [--need <GB>] [--floor <GB>] [--path <目录>] [--reclaim] [--gc <t3-worktree-gc.mjs 路径>]
//   --need   这一步预计新增的磁盘占用（构建产物等），缺省 0
//   --floor  跑完后至少留给本机的剩余空间，缺省 20
//   --path   要量的目录，缺省当前目录（工作树）；不存在时退到 T3 工作树根或主目录
//   --reclaim 先跑 t3-code 技能的 t3-worktree-gc.mjs --purge-build --apply：删已终结线程的孤儿工作树，
//            保留下来的工作树只清可重建的构建产物；只回收别人留下的垃圾，不动在用工作树
// 输出 { host, platform, path, diskFreeGB, diskTotalGB, needGB, floorGB, disk, cpus, cpuBusyPct, load, verdict, reclaim? }
//   disk: ok | short（剩余 − need < floor）；load: ok | busy（1 秒采样 CPU 繁忙 ≥ 85%）；verdict: go | wait
// 退出码：0 可以跑；3 资源不足（verdict=wait）；1 回收失败；2 用法错误。

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statfsSync } from "node:fs";
import { cpus, homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// bstack 技能安装时同级排布（~/.agents/skills/<name>）。
export const DEFAULT_GC = join(dirname(SKILL_DIR), "t3-code", "scripts", "t3-worktree-gc.mjs");
export const BUSY_PCT = 85;

export function probePath(path, env = process.env) {
  if (path && existsSync(path)) return path;
  const root = join(env.T3CODE_HOME || join(homedir(), ".t3"), "worktrees");
  return existsSync(root) ? root : homedir();
}

export function diskOf(path) {
  const s = statfsSync(path);
  const gb = (blocks) => Math.round(((blocks * s.bsize) / 1e9) * 10) / 10;
  return { diskFreeGB: gb(s.bavail), diskTotalGB: gb(s.blocks) };
}

// os.loadavg 在 Windows 恒为 0，改用两次 cpus() 采样的空闲占比，各平台一致。
export async function cpuBusyPct(ms = 1000) {
  const snap = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 100) : 0;
}

export function verdictOf({ diskFreeGB, needGB, floorGB, busyPct }) {
  const disk = diskFreeGB - needGB >= floorGB ? "ok" : "short";
  const load = busyPct >= BUSY_PCT ? "busy" : "ok";
  return { disk, load, verdict: disk === "ok" && load === "ok" ? "go" : "wait" };
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
  if (!existsSync(gc)) return { ok: false, error: `找不到 ${gc}（先 npx skills 装上 t3-code 技能）` };
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
  let needGB = 0;
  let floorGB = 20;
  let path = process.cwd();
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reclaim") doReclaim = true;
    else if (a === "--gc" && args[i + 1]) gc = args[++i];
    else if (a === "--path" && args[i + 1]) path = args[++i];
    else if (a === "--need" && args[i + 1]) needGB = num(args[++i]);
    else if (a === "--floor" && args[i + 1]) floorGB = num(args[++i]);
    else needGB = NaN;
    if (Number.isNaN(needGB) || Number.isNaN(floorGB)) {
      console.error("用法：node resource-check.mjs [--need <GB>] [--floor <GB>] [--path <目录>] [--reclaim] [--gc <t3-worktree-gc.mjs 路径>]");
      process.exit(2);
    }
  }
  path = probePath(path);
  const rec = doReclaim ? reclaim(gc, path) : null;
  const disk = diskOf(path);
  const busyPct = await cpuBusyPct();
  const v = verdictOf({ diskFreeGB: disk.diskFreeGB, needGB, floorGB, busyPct });
  console.log(
    JSON.stringify({ host: hostname(), platform: platform(), path, ...disk, needGB, floorGB, disk: v.disk, cpus: cpus().length, cpuBusyPct: busyPct, load: v.load, verdict: v.verdict, ...(rec ? { reclaim: rec } : {}) }, null, 1),
  );
  process.exit(rec && !rec.ok ? 1 : v.verdict === "go" ? 0 : 3);
}
