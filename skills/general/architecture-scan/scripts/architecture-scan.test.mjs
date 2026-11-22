import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  assertSafeCleanup,
  buildManifest,
  cleanup,
  defaultWorkDir,
  extractLastJson,
  initRun,
  parseStatusLine,
  RUN_KIND,
  stamp,
  validateFindings,
  writeManifest,
  LockError,
  ParseError,
  CleanupError,
  UsageError,
} from "./architecture-scan.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "architecture-scan.mjs");

const sampleFinding = {
  summary: "优先加深播放会话 adapter，避免折回协调器。",
  findings: [
    {
      severity: "P1",
      file: "src/session/adapter.ts",
      line: 42,
      title: "会话 adapter 折回协调器",
      body: "生产 adapter 仍持有协调器指针并把快照写回。",
      suggestion: "让 adapter 自己持有播放器，协调器只提交请求。",
      candidate: {
        name: "深化宿主播放会话 adapter",
        files: ["src/session/adapter.ts", "src/session/coordinator.ts"],
        problem: "seam 存在但生产实现把状态抄回协调器。",
        solution: "implementation 留在 adapter 后，协调器只读 FinalState。",
        strength: "Strong",
        wins: ["测试面回到 session interface", "locality 集中在 adapter"],
      },
    },
  ],
};

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

test("stamp 与默认目录名符合约定", () => {
  const t = new Date("2026-11-22T13:05:00+08:00");
  assert.equal(stamp(t), "20261122-1305");
  const dir = defaultWorkDir(t, 99);
  assert.match(dir, /architecture-scan-20261122-1305(-\d+)?$/);
});

test("extractLastJson 取最后一个完整对象，忽略前后文字和字符串里的括号", () => {
  const text = `thinking { not json
{"summary":"旧","findings":[]}
说明结束
{"summary":"新","findings":[{"severity":"Note","file":"a.rs","line":null,"title":"t","body":"b {x}","suggestion":"s","candidate":{"name":"n","files":["a.rs"],"problem":"p","solution":"o","strength":"Worth exploring","wins":["w"]}}]}
尾部文字
`;
  const { value } = extractLastJson(text);
  assert.equal(value.summary, "新");
  assert.equal(value.findings[0].body, "b {x}");
  validateFindings(value);
});

test("extractLastJson 在只有残缺 JSON 时失败", () => {
  assert.throws(() => extractLastJson("前言 {\"summary\":\"x\""), ParseError);
  assert.throws(() => extractLastJson("   "), ParseError);
});

test("validateFindings 拒绝缺 candidate、非法枚举和坏行号", () => {
  validateFindings(sampleFinding);
  const missing = structuredClone(sampleFinding);
  delete missing.findings[0].candidate;
  assert.throws(() => validateFindings(missing), /candidate/);
  const sev = structuredClone(sampleFinding);
  sev.findings[0].severity = "high";
  assert.throws(() => validateFindings(sev), /severity/);
  const str = structuredClone(sampleFinding);
  str.findings[0].candidate.strength = "maybe";
  assert.throws(() => validateFindings(str), /strength/);
  const line = structuredClone(sampleFinding);
  line.findings[0].line = -1;
  assert.throws(() => validateFindings(line), /line/);
});

test("锁：首次成功，重复 mkdir 失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-lock-"));
  try {
    const lock = acquireLock(dir, ".summary.lock");
    assert.ok(existsSync(lock));
    assert.throws(() => acquireLock(dir, ".summary.lock"), LockError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init-run 写入标记，cleanup 只删除该运行目录", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "arch-run-")), "architecture-scan-20261122-2100");
  const { dir: real, marker } = initRun(dir, new Date("2026-11-22T13:00:00Z"));
  assert.equal(marker.kind, RUN_KIND);
  assert.equal(marker.work_dir, real);
  writeFileSync(join(real, "example.out.txt"), "x");
  mkdirSync(join(real, "example-clone"));
  writeFileSync(join(real, "example-clone", "f.txt"), "c");
  const gone = cleanup(real);
  assert.equal(gone, real);
  assert.equal(existsSync(real), false);
});

test("cleanup 拒绝临时目录根、无标记目录和路径不一致", () => {
  assert.throws(() => assertSafeCleanup(tmpdir()), CleanupError);
  const stray = mkdtempSync(join(tmpdir(), "architecture-scan-20261122-2101-"));
  // mkdtemp appends random suffix that may still be invalid; ensure invalid name
  const bad = join(dirname(stray), "not-a-run-dir");
  mkdirSync(bad);
  try {
    assert.throws(() => assertSafeCleanup(bad), CleanupError);
    const valid = join(dirname(stray), "architecture-scan-20261122-2111");
    mkdirSync(valid);
    assert.throws(() => assertSafeCleanup(valid), /run.json/);
    writeFileSync(join(valid, "run.json"), JSON.stringify({
      kind: RUN_KIND,
      work_dir: join(valid, "elsewhere"),
    }));
    assert.throws(() => assertSafeCleanup(valid), /不一致|无法解析/);
  } finally {
    rmSync(stray, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
    const valid = join(dirname(stray), "architecture-scan-20261122-2111");
    rmSync(valid, { recursive: true, force: true });
  }
});

test("init-run 拒绝不合命名规则的目录", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "arch-bad-")), "scratch");
  assert.throws(() => initRun(dir), UsageError);
});

test("write-manifest 汇总 status 与 out 文件", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "arch-man-")), "architecture-scan-20261122-2200");
  initRun(dir);
  writeFileSync(join(dir, "alpha.status"), "ok 0 abcdef\n");
  writeFileSync(join(dir, "alpha.out.txt"), JSON.stringify(sampleFinding));
  writeFileSync(join(dir, "beta.status"), "timeout 124 \n");
  const { manifest } = writeManifest(dir, { finished: "2026-11-22T14:00:00+08:00" });
  assert.equal(manifest.task, "架构扫描");
  assert.equal(manifest.repos.length, 2);
  assert.deepEqual(manifest.repos[0], {
    short: "alpha",
    status: "ok",
    exit_code: 0,
    sha: "abcdef",
    out: "alpha.out.txt",
  });
  assert.equal(manifest.repos[1].status, "timeout");
  assert.equal(manifest.repos[1].exit_code, 124);
  assert.equal(manifest.repos[1].out, null);
  const disk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(disk.repos[0].sha, "abcdef");
  cleanup(dir);
});

test("parseStatusLine 处理缺字段", () => {
  assert.deepEqual(parseStatusLine("clone_failed 1"), {
    status: "clone_failed",
    exit_code: 1,
    sha: "",
  });
  assert.equal(parseStatusLine("weird").status, "missing");
});

test("CLI parse-out / validate-findings / 锁 / 帮助", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-cli-"));
  try {
    const outFile = join(dir, "a.out.txt");
    writeFileSync(outFile, `前置\n${JSON.stringify(sampleFinding)}\n`);
    let r = cli(["parse-out", outFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).summary, sampleFinding.summary);

    const jsonFile = join(dir, "ok.json");
    writeFileSync(jsonFile, JSON.stringify(sampleFinding));
    r = cli(["validate-findings", jsonFile]);
    assert.equal(r.status, 0, r.stderr);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ summary: "x", findings: [] }));
    // empty findings is schema-valid (zero findings allowed)
    r = cli(["validate-findings", bad]);
    assert.equal(r.status, 0, r.stderr);

    const worse = join(dir, "worse.json");
    writeFileSync(worse, JSON.stringify({ summary: "x", findings: [{ severity: "P1" }] }));
    r = cli(["validate-findings", worse]);
    assert.equal(r.status, 4);

    r = cli(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /init-run/);

    const work = join(dir, "architecture-scan-20261122-2300");
    r = cli(["init-run", "--work-dir", work]);
    assert.equal(r.status, 0, r.stderr);
    r = cli(["init-run", "--work-dir", work]);
    assert.equal(r.status, 3, "重复 init 应因锁失败");
    r = cli(["acquire-lock", "--work-dir", work.trim(), "--name", ".summary.lock"]);
    assert.equal(r.status, 0, r.stderr);
    r = cli(["acquire-lock", "--work-dir", work, "--name", ".summary.lock"]);
    assert.equal(r.status, 3);
    r = cli(["cleanup", "--work-dir", work]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(work), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置示例与文档不含凭证形态，且 schema 示例可校验", () => {
  const root = join(dirname(script), "..");
  const yaml = readFileSync(join(root, "references/config.example.yaml"), "utf8");
  assert.doesNotMatch(yaml, /fsk_[A-Za-z0-9]+/);
  assert.doesNotMatch(yaml, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(yaml, /api_key\s*:/);
  assert.match(yaml, /fast_ship:\s*\n\s*enabled:\s*false/);
  assert.match(yaml, /grok:\s*\n\s*enabled:\s*false/);
  assert.match(yaml, /targets:\s*\[\]/);

  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: architecture-scan\n/m);
  assert.doesNotMatch(skill, /\/home\/box/);
  assert.doesNotMatch(skill, /SCAN_WEBHOOK/);

  validateFindings(sampleFinding);
});

test("buildManifest 在空目录给出空 repos", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-empty-"));
  try {
    const manifest = buildManifest(dir);
    assert.deepEqual(manifest.repos, []);
    assert.equal(manifest.task, "架构扫描");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
