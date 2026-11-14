import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnvironments, DEFAULTS_PATH, CONFIG_FILE, ENVIRONMENTS_FILE } from "./patrol-config.mjs";

const DEFAULTS = JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
const SCRIPT = fileURLToPath(new URL("./patrol-config.mjs", import.meta.url));

function withConfig(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "bstack-cfg-"));
  try {
    if (content !== undefined) writeFileSync(join(dir, CONFIG_FILE), typeof content === "string" ? content : JSON.stringify(content));
    return fn({ BSTACK_CONFIG_DIR: dir }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("没有配置文件时完全等于默认值", () => {
  withConfig(undefined, (env) => {
    const r = loadConfig({ env });
    assert.equal(r.source, "defaults");
    assert.deepEqual(r.config, DEFAULTS);
    assert.deepEqual([...r.warnings, ...r.errors], []);
  });
});

test("嵌套对象逐键覆盖，未写的键保留默认值", () => {
  withConfig({ version: 1, capacity: { pools: { heavy: 4 } }, thresholds: { queuedMinutes: 45 } }, (env) => {
    const r = loadConfig({ env });
    assert.equal(r.config.capacity.pools.heavy, 4);
    assert.equal(r.config.capacity.minFreeDiskGB, DEFAULTS.capacity.minFreeDiskGB);
    assert.equal(r.config.thresholds.queuedMinutes, 45);
    assert.equal(r.config.thresholds.silenceMinutes, DEFAULTS.thresholds.silenceMinutes);
    assert.deepEqual(r.warnings, []);
  });
});

test("未知键与类型不符报警告，不生效", () => {
  withConfig({ capacity: { maxActive: 3, minFreeDiskGB: "10" }, extra: true }, (env) => {
    const r = loadConfig({ env });
    assert.deepEqual(r.config.capacity, DEFAULTS.capacity);
    assert.equal(r.config.extra, undefined);
    assert.equal(r.warnings.length, 3);
    assert.ok(r.warnings.some((w) => w.startsWith("capacity.maxActive：")));
    assert.ok(r.warnings.some((w) => w.startsWith("capacity.minFreeDiskGB：应为 number")));
  });
});

test("模型阶梯整体替换；残缺的阶梯回落默认", () => {
  const ladder = [{ name: "x", instanceId: "codex", model: "gpt-x", options: {} }];
  withConfig({ modelLadder: ladder }, (env) => {
    assert.deepEqual(loadConfig({ env }).config.modelLadder, ladder);
  });
  for (const bad of [[], [{ model: "gpt-x" }]]) {
    withConfig({ modelLadder: bad }, (env) => {
      const r = loadConfig({ env });
      assert.deepEqual(r.config.modelLadder, DEFAULTS.modelLadder);
      assert.ok(r.warnings.some((w) => w.startsWith("modelLadder：")));
    });
  }
});

test("带 BOM 的文件照常解析", () => {
  withConfig("\uFEFF" + JSON.stringify({ capacity: { pools: { general: 4 } } }), (env) => {
    assert.equal(loadConfig({ env }).config.capacity.pools.general, 4);
  });
});

test("版本高于技能时报警告", () => {
  withConfig({ version: DEFAULTS.version + 1 }, (env) => {
    assert.ok(loadConfig({ env }).warnings.some((w) => w.startsWith("version：")));
  });
});

test("损坏的文件记 errors 并回落默认值；CLI 退出码 3", () => {
  for (const content of ["{ capacity: ", "[1, 2]"]) {
    withConfig(content, (env) => {
      const r = loadConfig({ env });
      assert.equal(r.errors.length, 1);
      assert.deepEqual(r.config, DEFAULTS);
      const cli = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, encoding: "utf8" });
      assert.equal(cli.status, 3);
      assert.equal(JSON.parse(cli.stdout).errors.length, 1);
    });
  }
});

test("environments.json：坏条目与重复 environmentId 丢弃并报警告；缺失时为空", () => {
  withConfig(undefined, (env, dir) => {
    assert.deepEqual(loadEnvironments({ env }).environments, {});
    writeFileSync(join(dir, ENVIRONMENTS_FILE), JSON.stringify({
      version: 1,
      environments: {
        pc: { environmentId: "env-pc", device: "Windows PC", os: "windows" },
        mini: { environmentId: "env-mini", os: "mac" },
        dup: { environmentId: "env-pc" },
        broken: { device: "x" },
      },
    }));
    const r = loadEnvironments({ env });
    assert.deepEqual(r.environments, {
      pc: { environmentId: "env-pc", device: "Windows PC", os: "windows" },
      mini: { environmentId: "env-mini", device: null, os: null },
    });
    assert.equal(r.warnings.length, 3);
    writeFileSync(join(dir, ENVIRONMENTS_FILE), "{");
    assert.equal(loadEnvironments({ env }).errors.length, 1);
  });
});

test("容量池：设备条目逐条校验，坏条目丢弃", () => {
  withConfig({ capacity: { devices: [{ device: "pc", pools: { heavy: 5, general: 4 } }, { device: "x", pools: { heavy: -1 } }, 3] } }, (env) => {
    const r = loadConfig({ env });
    assert.deepEqual(r.config.capacity.devices, [
      { device: "pc", pools: { heavy: 5, general: 4 } },
      { device: "x", pools: {} },
    ]);
    assert.equal(r.warnings.length, 2);
    assert.deepEqual(r.config.capacity.pools, DEFAULTS.capacity.pools);
  });
});
