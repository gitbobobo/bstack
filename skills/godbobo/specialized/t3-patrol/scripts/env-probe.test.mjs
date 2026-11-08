import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeGc } from "./env-probe.mjs";

const SCRIPT = fileURLToPath(new URL("./env-probe.mjs", import.meta.url));

test("gc 输出只留汇总行与失败行", () => {
  const out = ["扫描根：/x（--apply）", "deleted        a/b  branch=t3/x", "failed         a/c  rm 失败", "汇总：共 2 个目录", "构建产物：可清 0 / 已清 1，空间未统计", "在用工作树（绑定线程未终结或有进行中 run）：3 个"].join("\n");
  const s = summarizeGc(out);
  assert.equal(s.summary.length, 4);
  assert.deepEqual(s.failed, ["failed         a/c  rm 失败"]);
});

test("CLI：量工作树根所在磁盘；--reclaim 调 gc 并带回汇总，gc 失败时退出码 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-probe-"));
  try {
    mkdirSync(join(dir, "worktrees"));
    const env = { ...process.env, T3CODE_HOME: dir };
    const plain = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });
    assert.equal(plain.status, 0, plain.stderr);
    const p = JSON.parse(plain.stdout);
    assert.equal(p.path, join(dir, "worktrees"));
    assert.ok(p.diskFreeGB > 0 && p.diskTotalGB >= p.diskFreeGB);
    assert.equal(p.reclaim, undefined);

    const gc = join(dir, "gc.mjs");
    writeFileSync(gc, `if (process.argv.slice(2).join(" ") !== "--purge-build --apply") process.exit(9);\nconsole.log("汇总：共 0 个目录");\n`);
    const ok = JSON.parse(spawnSync(process.execPath, [SCRIPT, "--reclaim", "--gc", gc], { encoding: "utf8", env }).stdout);
    assert.equal(ok.reclaim.ok, true);
    assert.deepEqual(ok.reclaim.summary, ["汇总：共 0 个目录"]);
    assert.equal(typeof ok.reclaim.freedGB, "number");

    writeFileSync(gc, `console.log("failed         a/c  x"); process.exit(1);\n`);
    const bad = spawnSync(process.execPath, [SCRIPT, "--reclaim", "--gc", gc], { encoding: "utf8", env });
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout).reclaim.failed, ["failed         a/c  x"]);

    const missing = spawnSync(process.execPath, [SCRIPT, "--reclaim", "--gc", join(dir, "nope.mjs")], { encoding: "utf8", env });
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).reclaim.error, /找不到/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--bogus"]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
