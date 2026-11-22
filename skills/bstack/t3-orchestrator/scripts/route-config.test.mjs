import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as DEFAULTS from "./route-data.mjs";
import { buildRouteData, CONFIG_FILE } from "./route-config.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CAPS_FILE = join(DIR, "fixtures", "caps-trimmed.json");

function withConfig(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "route-cfg-"));
  try {
    if (content !== undefined) writeFileSync(join(dir, CONFIG_FILE), typeof content === "string" ? content : JSON.stringify(content));
    const run = (...args) => spawnSync(process.execPath, [join(DIR, "route.mjs"), ...args], { env: { ...process.env, BSTACK_CONFIG_DIR: dir }, encoding: "utf8" });
    return fn(run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("空配置等于默认路由数据，且不改动 route-data 导出的对象", () => {
  const r = buildRouteData({});
  assert.deepEqual(r.MODELS, DEFAULTS.MODELS);
  assert.deepEqual([r.IMPLEMENTERS, r.ADVISORS, r.MAX_ATTEMPTS], [DEFAULTS.IMPLEMENTERS, DEFAULTS.ADVISORS, DEFAULTS.MAX_ATTEMPTS]);
  assert.deepEqual(r.warnings, []);
  r.MODELS["glm-5.3-flash"].effort = "max";
  r.IMPLEMENTERS.pop();
  assert.equal(DEFAULTS.MODELS["glm-5.3-flash"].effort, "high");
  assert.equal(DEFAULTS.IMPLEMENTERS.length, 3);
});

test("覆盖模型字段、新增模型并替换两类池", () => {
  const r = buildRouteData({
    version: 2,
    models: {
      "glm-5.3-flash": { effort: "medium" },
      mine: { label: "Mine", effort: "high", entries: [{ provider: "pi", id: "x/mine" }] },
    },
    implementers: ["mine", "swe-2"],
    advisors: ["gpt-6.2-sol", "opus-5.5"],
    maxAttempts: 2,
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.MODELS["glm-5.3-flash"].effort, "medium");
  assert.deepEqual(r.MODELS["glm-5.3-flash"].entries, DEFAULTS.MODELS["glm-5.3-flash"].entries);
  assert.deepEqual([r.IMPLEMENTERS, r.ADVISORS, r.MAX_ATTEMPTS], [["mine", "swe-2"], ["gpt-6.2-sol", "opus-5.5"], 2]);
});

test("不合法的部分报警告并沿用默认值", () => {
  const r = buildRouteData({
    version: 1,
    extra: 1,
    models: { "swe-2": { effort: "", entries: [], speed: 1 }, half: { label: "Half" } },
    implementers: [],
    advisors: ["nope"],
    maxAttempts: 0,
  });
  assert.deepEqual(r.MODELS["swe-2"], DEFAULTS.MODELS["swe-2"]);
  assert.equal(r.MODELS.half, undefined);
  assert.deepEqual([r.IMPLEMENTERS, r.ADVISORS, r.MAX_ATTEMPTS], [DEFAULTS.IMPLEMENTERS, DEFAULTS.ADVISORS, DEFAULTS.MAX_ATTEMPTS]);
  for (const prefix of ["extra：", "version：", "models.swe-2.effort：", "models.swe-2.entries：", "models.swe-2.speed：", "models.half：", "implementers：", "advisors：", "maxAttempts："]) {
    assert.ok(r.warnings.some((w) => w.startsWith(prefix)), `缺少警告 ${prefix}\n${r.warnings.join("\n")}`);
  }
});

test("同一模型不能同时在两池：从顾问池移除", () => {
  const r = buildRouteData({ advisors: ["gpt-6.2-sol", "swe-2"] });
  assert.deepEqual(r.ADVISORS, ["gpt-6.2-sol"]);
  assert.ok(r.warnings.some((w) => w.includes("swe-2 同时在实现池")));
});

test("CLI：配置生效于 impl，并在输出里报配置警告；损坏的文件回落默认值", () => {
  withConfig({ implementers: ["swe-2"], typo: true }, (run) => {
    const r = run("impl", "--caps-file", CAPS_FILE);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PICK swe-2 /m);
    assert.match(r.stdout, /WARN 配置 .*typo：未知配置项/);
  });
  withConfig("{ broken", (run) => {
    const r = run("impl", "--caps-file", CAPS_FILE);
    assert.match(r.stdout, /^PICK glm-5\.3-flash /m);
    assert.match(r.stdout, /WARN 配置 .*无法解析/);
    assert.match(run("table").stdout, /^配置来源：.*t3-orchestrator\.json/m);
  });
});
