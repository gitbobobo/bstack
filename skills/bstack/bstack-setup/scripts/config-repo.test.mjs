import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGitignore } from "./config-repo.mjs";

const SCRIPT = fileURLToPath(new URL("./config-repo.mjs", import.meta.url));
// 提交用本机已配置的 git 身份；没配置的设备跳过需要提交的用例。
const hasIdentity = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout.trim() !== "";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bstack-repo-"));
  const remote = join(root, "remote.git");
  spawnSync("git", ["init", "--bare", "-b", "main", remote]);
  const run = (dir, ...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, BSTACK_CONFIG_DIR: dir }, encoding: "utf8" });
    return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { root, remote, run, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("不是仓库时 pull 与 commit 不做事", () => {
  const f = fixture();
  try {
    const dir = join(f.root, "cfg");
    mkdirSync(dir);
    assert.deepEqual(f.run(dir, "pull").out, { ok: true, action: "skip", reason: "not-a-repo" });
    assert.equal(f.run(dir, "commit", "-m", "x").out.reason, "not-a-repo");
    assert.equal(f.run(dir, "status").out.repo, false);
    assert.equal(f.run(dir, "bogus").status, 2);
  } finally {
    f.cleanup();
  }
});

test("init → clone → commit → pull 往返；分叉时 pull 失败、commit 变基后推送", { skip: !hasIdentity }, () => {
  const f = fixture();
  try {
    const a = join(f.root, "a");
    const b = join(f.root, "b");
    mkdirSync(join(a, "secrets"), { recursive: true });
    writeFileSync(join(a, "t3-patrol.json"), '{"version":1}\n');
    writeFileSync(join(a, "secrets", "token"), "s3cret");
    assert.equal(f.run(a, "init", "--remote", f.remote).status, 0);
    assert.equal(f.run(a, "init", "--remote", f.remote).status, 2);

    assert.equal(f.run(b, "clone", f.remote).status, 0);
    assert.ok(existsSync(join(b, "t3-patrol.json")));
    assert.ok(!existsSync(join(b, "secrets")));

    writeFileSync(join(b, "t3-patrol.json"), '{"version":1,"capacity":{"maxActiveThreads":3}}\n');
    assert.deepEqual(f.run(b, "commit", "-m", "chore(t3-patrol): lower capacity").out, { ok: true, action: "commit", committed: true, pushed: true });
    assert.equal(f.run(a, "pull").out.updated, true);
    assert.match(readFileSync(join(a, "t3-patrol.json"), "utf8"), /maxActiveThreads/);

    writeFileSync(join(b, "environments.json"), '{"version":1}\n');
    assert.equal(f.run(b, "commit", "-m", "chore: add environments").status, 0);
    writeFileSync(join(a, "t3-orchestrator.json"), '{"version":1}\n');
    f.git(a, "add", "-A");
    f.git(a, "commit", "-m", "local");
    assert.equal(f.run(a, "pull").status, 1);
    assert.equal(f.run(a, "commit", "-m", "noop").out.pushed, true);
    assert.equal(f.run(b, "pull").status, 0);
    assert.ok(existsSync(join(b, "t3-orchestrator.json")));
    assert.deepEqual(f.run(b, "status").out.dirty, []);
  } finally {
    f.cleanup();
  }
});

test("clone 到非空目录须确认，确认后原目录改名保留", { skip: !hasIdentity }, () => {
  const f = fixture();
  try {
    const seed = join(f.root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "a.json"), "{}");
    assert.equal(f.run(seed, "init", "--remote", f.remote).status, 0);
    const dir = join(f.root, "cfg");
    mkdirSync(dir);
    writeFileSync(join(dir, "local.json"), "{}");
    assert.equal(f.run(dir, "clone", f.remote).status, 2);
    const r = f.run(dir, "clone", f.remote, "--backup-existing");
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(r.out.backup, "local.json")));
    assert.ok(existsSync(join(dir, "a.json")));
    assert.equal(readdirSync(f.root).filter((n) => n.startsWith("cfg.bak-")).length, 1);
  } finally {
    f.cleanup();
  }
});

test("状态输出去掉远端 URL 里的凭据", () => {
  const f = fixture();
  try {
    const dir = join(f.root, "cfg");
    mkdirSync(dir);
    f.git(dir, "init", "-b", "main");
    f.git(dir, "remote", "add", "origin", "https://user:tok@example.com/me/bstack-config.git");
    assert.equal(f.run(dir, "status").out.remote, "https://example.com/me/bstack-config.git");
  } finally {
    f.cleanup();
  }
});

test("外层目录是仓库时，配置目录本身仍算不是仓库", () => {
  const f = fixture();
  try {
    f.git(f.root, "init", "-b", "main");
    const dir = join(f.root, "cfg");
    mkdirSync(dir);
    assert.equal(f.run(dir, "status").out.repo, false);
    assert.equal(f.run(dir, "pull").out.reason, "not-a-repo");
  } finally {
    f.cleanup();
  }
});

test("老仓库的 .gitignore 只补缺的本机条目，原有行保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "bstack-ign-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "secrets/\nPAUSE");
    assert.deepEqual(ensureGitignore(dir), ["state/"]);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "secrets/\nPAUSE\nstate/\n");
    assert.deepEqual(ensureGitignore(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
