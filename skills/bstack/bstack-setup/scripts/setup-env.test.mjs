import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = process.env.SETUP_ENV_TEST_SCRIPT || join(dirname(fileURLToPath(import.meta.url)), "setup-env.mjs");
const posix = process.platform !== "win32";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "setup-env-test-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const preload = join(root, "home.mjs");
  writeFileSync(preload, `import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.homedir = () => process.env.SETUP_ENV_TEST_HOME;
syncBuiltinESMExports();
`);
  const env = { ...process.env, SETUP_ENV_TEST_HOME: home, CARGO_HOME: join(root, "cargo"), PATH: `${bin}:/usr/bin:/bin` };
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, SCRIPT, ...args], {
    env, encoding: "utf8", timeout: 10000,
  });
  return { root, home, bin, env, run };
}

test("cargo-nextest 发现：迁移目录/默认目录已有工具，PATH 不可见时不提示重装", { skip: !posix }, () => {
  const f = fixture();
  const cargoBin = join(f.env.CARGO_HOME, "bin");
  mkdirSync(cargoBin, { recursive: true });
  writeFileSync(join(cargoBin, "cargo-nextest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  let r = f.run("--check");
  assert.match(r.stdout, /PATH不可见\s+tool:cargo-nextest/);
  assert.ok(r.stdout.includes(cargoBin));
  assert.doesNotMatch(r.stdout, /未安装\s+tool:cargo-nextest/);
  f.env.PATH = `${cargoBin}:${f.env.PATH}`;
  assert.match(f.run("--check").stdout, /已安装\s+tool:cargo-nextest/);

  const fallback = fixture();
  const defaultBin = join(fallback.home, ".cargo", "bin");
  mkdirSync(defaultBin, { recursive: true });
  writeFileSync(join(defaultBin, "cargo-nextest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.match(fallback.run("--check").stdout, /PATH不可见\s+tool:cargo-nextest/);
  const absent = fixture();
  assert.match(absent.run("--check").stdout, /未安装\s+tool:cargo-nextest.*cargo install/);
  const notExecutable = join(absent.home, ".cargo", "bin");
  mkdirSync(notExecutable, { recursive: true });
  writeFileSync(join(notExecutable, "cargo-nextest"), "not executable", { mode: 0o644 });
  assert.match(absent.run("--check").stdout, /未安装\s+tool:cargo-nextest/);
});

test("sccache：装了就写入 rustc-wrapper，已有 [build] 段合并，别的 wrapper 不覆盖", { skip: !posix }, async () => {
  const { readFileSync } = await import("node:fs");
  const absent = fixture();
  assert.match(absent.run("--check").stdout, /未安装\s+cargo:sccache/);

  const f = fixture();
  writeFileSync(join(f.bin, "sccache"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.match(f.run("--check").stdout, /待处理\s+cargo:rustc-wrapper/);
  mkdirSync(f.env.CARGO_HOME, { recursive: true });
  const cfg = join(f.env.CARGO_HOME, "config.toml");
  writeFileSync(cfg, "[build]\njobs = 4\n");
  assert.match(f.run().stdout, /已配置\s+cargo:rustc-wrapper\s+sccache/);
  assert.equal(readFileSync(cfg, "utf8"), '[build]\nrustc-wrapper = "sccache"\njobs = 4\n');
  assert.match(f.run("--check").stdout, /已配置\s+cargo:rustc-wrapper\s+sccache/);

  const other = fixture();
  writeFileSync(join(other.bin, "sccache"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(other.env.CARGO_HOME, { recursive: true });
  writeFileSync(join(other.env.CARGO_HOME, "config.toml"), '[build]\nrustc-wrapper = "ccache-rs"\n');
  assert.match(other.run().stdout, /其他\s+cargo:rustc-wrapper\s+ccache-rs/);
});

test("旧 setup-env 链接（含悬空）直接改指真源，不留备份", { skip: !posix }, async () => {
  const { readdirSync, readlinkSync, realpathSync } = await import("node:fs");
  const f = fixture();
  const legacy = join(f.root, "skills", "setup-env", "rules", "AGENTS.md");
  const target = join(f.home, ".codex", "AGENTS.md");
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(legacy, target);
  assert.match(f.run("--check").stdout, /旧链接\s+codex/);
  f.run();
  const source = join(dirname(SCRIPT), "..", "rules", "AGENTS.md");
  assert.equal(realpathSync(readlinkSync(target)), realpathSync(source));
  assert.deepEqual(readdirSync(dirname(target)).filter((n) => n.includes(".bak-")), []);
  assert.match(f.run("--check").stdout, /已链接\s+codex/);
});
