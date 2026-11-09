import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMemoryPressure, summarizeGc, verdictOf } from "./resource-check.mjs";

const SCRIPT = fileURLToPath(new URL("./resource-check.mjs", import.meta.url));

test("gc 输出只留汇总行与失败行", () => {
  const out = ["扫描根：/x（--apply）", "deleted        a/b  branch=t3/x", "failed         a/c  rm 失败", "汇总：共 2 个目录", "构建产物：可清 0 / 已清 1，空间未统计", "在用工作树（绑定线程未终结或有进行中 run）：3 个"].join("\n");
  const s = summarizeGc(out);
  assert.equal(s.summary.length, 4);
  assert.deepEqual(s.failed, ["failed         a/c  rm 失败"]);
});

test("判定：跑完仍留足保底、CPU 不满且内存不低才放行", () => {
  assert.deepEqual(verdictOf({ diskFreeGB: 60, needGB: 30, floorGB: 20, busyPct: 40, memPct: 30 }), { disk: "ok", load: "ok", memory: "ok", verdict: "go" });
  assert.deepEqual(verdictOf({ diskFreeGB: 45, needGB: 30, floorGB: 20, busyPct: 40, memPct: 30 }), { disk: "short", load: "ok", memory: "ok", verdict: "wait" });
  assert.deepEqual(verdictOf({ diskFreeGB: 60, needGB: 0, floorGB: 20, busyPct: 95, memPct: 30 }), { disk: "ok", load: "busy", memory: "ok", verdict: "wait" });
  assert.deepEqual(verdictOf({ diskFreeGB: 60, needGB: 0, floorGB: 20, busyPct: 40, memPct: 5 }), { disk: "ok", load: "ok", memory: "low", verdict: "wait" });
  assert.equal(verdictOf({ diskFreeGB: 60, needGB: 0, floorGB: 20, busyPct: 40 }).verdict, "go", "内存量不到时不拦");
});

test("判定：经调度入口排队时 CPU 繁忙交给队列，磁盘与内存照拦", () => {
  assert.equal(verdictOf({ diskFreeGB: 60, needGB: 0, floorGB: 20, busyPct: 100, memPct: 30, queued: true }).verdict, "go");
  assert.equal(verdictOf({ diskFreeGB: 60, needGB: 0, floorGB: 20, busyPct: 100, memPct: 5, queued: true }).verdict, "wait");
  assert.equal(verdictOf({ diskFreeGB: 10, needGB: 0, floorGB: 20, busyPct: 0, memPct: 30, queued: true }).verdict, "wait");
});

test("macOS memory_pressure：取系统空闲百分比，格式不认得时为 null", () => {
  assert.equal(parseMemoryPressure("The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 33%\n"), 33);
  assert.equal(parseMemoryPressure("garbage"), null);
});

test("CLI：量指定目录；--need 不足时退出码 3；--reclaim 调 gc 并带回汇总，gc 失败时退出码 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "resource-check-"));
  try {
    mkdirSync(join(dir, "worktrees"));
    const env = { ...process.env, T3CODE_HOME: dir };
    const plain = spawnSync(process.execPath, [SCRIPT, "--path", dir, "--floor", "0"], { encoding: "utf8", env });
    const p = JSON.parse(plain.stdout);
    assert.equal(p.path, dir);
    assert.ok(p.diskFreeGB > 0 && p.diskTotalGB >= p.diskFreeGB);
    assert.equal(p.reclaim, undefined);
    assert.ok(["go", "wait"].includes(p.verdict));
    assert.equal(plain.status, p.verdict === "go" ? 0 : 3);
    assert.ok(["ok", "low", "unknown"].includes(p.memory));
    assert.equal(p.queued, false);

    const short = spawnSync(process.execPath, [SCRIPT, "--path", dir, "--need", "999999"], { encoding: "utf8", env });
    assert.equal(short.status, 3);
    assert.equal(JSON.parse(short.stdout).disk, "short");

    const fallback = JSON.parse(spawnSync(process.execPath, [SCRIPT, "--path", join(dir, "nope"), "--floor", "0"], { encoding: "utf8", env }).stdout);
    assert.equal(fallback.path, join(dir, "worktrees"));

    const gc = join(dir, "gc.mjs");
    writeFileSync(gc, `if (process.argv.slice(2).join(" ") !== "--purge-build --apply") process.exit(9);\nconsole.log("汇总：共 0 个目录");\n`);
    const ok = JSON.parse(spawnSync(process.execPath, [SCRIPT, "--path", dir, "--reclaim", "--gc", gc], { encoding: "utf8", env }).stdout);
    assert.equal(ok.reclaim.ok, true);
    assert.deepEqual(ok.reclaim.summary, ["汇总：共 0 个目录"]);
    assert.equal(typeof ok.reclaim.freedGB, "number");

    writeFileSync(gc, `console.log("failed         a/c  x"); process.exit(1);\n`);
    const bad = spawnSync(process.execPath, [SCRIPT, "--path", dir, "--reclaim", "--gc", gc], { encoding: "utf8", env });
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout).reclaim.failed, ["failed         a/c  x"]);

    const missing = spawnSync(process.execPath, [SCRIPT, "--path", dir, "--reclaim", "--gc", join(dir, "nope.mjs")], { encoding: "utf8", env });
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).reclaim.error, /找不到/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--bogus"]).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--need", "abc"]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
