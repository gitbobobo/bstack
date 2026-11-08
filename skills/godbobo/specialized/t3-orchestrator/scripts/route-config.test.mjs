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
  assert.deepEqual(r.ROUTES, DEFAULTS.ROUTES);
  assert.equal(r.MAX_ATTEMPTS, DEFAULTS.MAX_ATTEMPTS);
  assert.deepEqual(r.warnings, []);
  r.MODELS["glm-5.3-flash"].status = "named";
  assert.equal(DEFAULTS.MODELS["glm-5.3-flash"].status, "auto");
});

test("覆盖已有模型字段、新增模型并整行替换路由", () => {
  const r = buildRouteData({
    version: 1,
    models: {
      "glm-5.3-flash": { status: "named" },
      mine: { label: "Mine", status: "auto", entries: [{ provider: "pi", id: "x/mine", options: { thinking: "high" } }] },
    },
    routes: { general: [{ model: "mine", provider: "pi" }, { model: "swe-2", provider: "acpRegistry_devin" }] },
    maxAttempts: 2,
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.MODELS["glm-5.3-flash"].status, "named");
  assert.deepEqual(r.MODELS["glm-5.3-flash"].entries, DEFAULTS.MODELS["glm-5.3-flash"].entries);
  assert.equal(r.MODELS.mine.label, "Mine");
  assert.equal(r.ROUTES.general[0].model, "mine");
  assert.deepEqual(r.ROUTES.review, DEFAULTS.ROUTES.review);
  assert.equal(r.MAX_ATTEMPTS, 2);
});

test("不合法的部分报警告并沿用默认值", () => {
  const r = buildRouteData({
    extra: 1,
    models: {
      "swe-2": { status: "sometimes", tasks: ["cook"], entries: [], speed: 1 },
      half: { label: "Half" },
    },
    routes: { general: [{ model: "nope", provider: "pi" }], cooking: [] },
    maxAttempts: 0,
  });
  assert.deepEqual(r.MODELS["swe-2"], DEFAULTS.MODELS["swe-2"]);
  assert.equal(r.MODELS.half, undefined);
  assert.deepEqual(r.ROUTES, DEFAULTS.ROUTES);
  assert.equal(r.MAX_ATTEMPTS, DEFAULTS.MAX_ATTEMPTS);
  for (const prefix of ["extra：", "models.swe-2.status：", "models.swe-2.tasks：", "models.swe-2.entries：", "models.swe-2.speed：", "models.half：", "routes.general：", "routes.cooking：", "maxAttempts："]) {
    assert.ok(r.warnings.some((w) => w.startsWith(prefix)), `缺少警告 ${prefix}\n${r.warnings.join("\n")}`);
  }
});

test("删掉入口后默认路由行里引用它的候选会被点名", () => {
  const r = buildRouteData({ models: { "grok-4.7": { entries: [{ provider: "pi", id: "cliproxyapi/grok-4.7", options: { thinking: "medium" } }] } } });
  assert.ok(r.warnings.some((w) => w.includes("grok-4.7@acpRegistry_factory_droid")));
});

test("CLI：配置生效于 select，并在输出里报配置警告；损坏的文件回落默认值", () => {
  withConfig({ models: { "glm-5.3-flash": { status: "named" } }, typo: true }, (run) => {
    const r = run("select", "--task", "general", "--caps-file", CAPS_FILE);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PICK acpRegistry_devin \/ swe-2-high/m);
    assert.match(r.stdout, /WARN 配置 .*typo：未知配置项/);
  });
  withConfig("{ broken", (run) => {
    const r = run("select", "--task", "general", "--caps-file", CAPS_FILE);
    assert.match(r.stdout, /^PICK pi \/ cliproxyapi\/glm-5\.3-flash/m);
    assert.match(r.stdout, /WARN 配置 .*无法解析/);
    assert.match(run("table").stdout, /^配置来源：.*t3-orchestrator\.json/m);
  });
});
