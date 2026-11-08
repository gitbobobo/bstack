// route.mjs 行为测试：select 的展开/过滤顺序、check 的硬性规则、named 的点名放行。
// 运行：node --test route.test.mjs
// 固定输入固定输出：caps 用 fixture，不触网不读本机缓存。
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { MODELS, ROUTES, EFFORT_STANDARD, EFFORT_MEDIUM, EFFORT_MEDIUM_MODELS, EFFORT_OPTION_IDS } from "./route-data.mjs";

// 本机 ~/.config/bstack/t3-orchestrator.json 不能影响默认路由的断言：先指向空目录再加载 route.mjs，子进程继承该变量。
process.env.BSTACK_CONFIG_DIR = mkdtempSync(join(tmpdir(), "route-cfg-"));
const { expandRoute, whitelistCands, loadProviders, validateOptions, injectOptions, auditRouteData } = await import("./route.mjs");

const DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(DIR, "route.mjs");
const CAPS_FILE = join(DIR, "fixtures", "caps-trimmed.json");

// caps fixture：实时 orchestrator_capabilities 裁剪到 route-data 用到的 provider/模型，
// canRunChildTask 归一化为 true。重新生成方法见 references/models.md「选项与档位」。
const CAPS = JSON.parse(readFileSync(CAPS_FILE, "utf8"));

function fixture(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "route-test-"));
  const caps = join(dir, "caps.json");
  const data = structuredClone(CAPS);
  mutate?.(data);
  writeFileSync(caps, JSON.stringify(data));
  return { dir, caps, base: ["--caps-file", caps], cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...opts });
const pick = (r) => `${r.stdout}`.match(/^PICK (\S+) \/ (\S+)/m);
const pickOf = (r) => {
  const m = pick(r);
  return m ? `${m[1]}/${m[2]}` : null;
};
const select = (args, mutate) => {
  const f = fixture(mutate);
  try {
    return run(["select", ...args, ...f.base]);
  } finally {
    f.cleanup();
  }
};
const eq = (a, b, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n期望 ${JSON.stringify(b)}\n实际 ${JSON.stringify(a)}`);
};

// ============ check ============

const ok = (args) => {
  const r = run(["check", ...args]);
  if (r.status !== 0) throw new Error(`应放行却拦截: ${args.join(" ")}\n${r.stdout}${r.stderr}`);
};
const fail = (args, needle) => {
  const r = run(["check", ...args]);
  if (r.status !== 1) throw new Error(`应拦截却放行: ${args.join(" ")}\n${r.stdout}`);
  if (needle && !`${r.stdout}${r.stderr}`.includes(needle)) throw new Error(`报错缺少 "${needle}": ${args.join(" ")}\n${r.stdout}${r.stderr}`);
};
const DROID = ["--options", '{"autonomy_level":"auto-high"}'];

test("check: 清单外组合非点名恒红、用户点名降级 warn", () => {
  fail(["--provider", "codex", "--model", "gpt-6-astra"], "入口清单");
  fail(["--provider", "pi", "--model", "cliproxyapi/grok-4.6"], "入口清单");
  fail(["--provider", "pi", "--model", "opencode-go/glm-5.3-flash"], "入口清单");
  ok(["--provider", "pi", "--model", "cliproxyapi/grok-4.6", "--user-named"]);
});

test("check: 快速模式恒红", () => {
  fail(["--provider", "pi", "--model", "cliproxyapi/glm-5.3-flash", "--options", '{"fastMode":true}'], "fastMode");
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--options", '{"serviceTier":"priority"}'], "priority");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "gpt-6-sol-fast", ...DROID, "--user-named"], "-fast");
});

test("check: 顾问不写实现，Opus 只做实现顾问（用户点名降级 warn）", () => {
  fail(["--provider", "pi", "--model", "cliproxyapi/gpt-6.1-sol", "--role", "implementation"], "顾问");
  ok(["--provider", "pi", "--model", "cliproxyapi/gpt-6.1-sol", "--role", "review"]);
  fail(["--provider", "acpRegistry_devin", "--model", "claude-opus-5-5-medium", "--role", "review"], "只承担 design");
  ok(["--provider", "acpRegistry_devin", "--model", "claude-opus-5-5-medium", "--role", "design"]);
  ok(["--provider", "acpRegistry_devin", "--model", "claude-opus-5-5-medium", "--role", "review", "--user-named"]);
});

test("check: droid 选项名与 autonomy_level", () => {
  fail(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash"], "autonomy_level");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash", "--options", '{"autonomy_level":"auto-high","reasoningEffort":"high"}'], "snake_case");
  ok(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash", ...DROID]);
});

test("check --caps-file: 选项取值按目录校验", () => {
  fail(["--provider", "pi", "--model", "cliproxyapi/glm-5.3-flash", "--options", '{"thinking":"max"}', "--caps-file", CAPS_FILE], "非法取值");
  ok(["--provider", "pi", "--model", "cliproxyapi/glm-5.3-flash", "--options", '{"thinking":"high"}', "--caps-file", CAPS_FILE]);
});

// ============ route-data 不变量 ============

test("route-data: 首选入口（用户定 2026-11-04）：swe-2 只走 devin，opus 从 devin/droid 选，其余首选 pi", () => {
  eq(MODELS["swe-2"].entries.map((e) => e.provider), ["acpRegistry_devin"]);
  eq(MODELS["opus-5.5"].entries.map((e) => e.provider), ["acpRegistry_devin", "acpRegistry_factory_droid"]);
  for (const [k, m] of Object.entries(MODELS)) {
    if (k === "swe-2" || k === "opus-5.5") continue;
    eq(m.entries[0].provider, "pi", k);
  }
});

test("route-data: 每个入口恰好一个档位选项；medium 模型在目录有 medium 时用 medium，否则 high", () => {
  const { providers } = loadProviders(CAPS_FILE);
  for (const [k, m] of Object.entries(MODELS)) {
    for (const e of m.entries) {
      const keys = Object.keys(e.options ?? {}).filter((o) => EFFORT_OPTION_IDS.includes(o));
      eq(keys.length, 1, `${k} ${e.provider}/${e.id} 档位选项数`);
      const hasMedium = providers.get(e.provider).optionSpecs.get(e.id).get(keys[0]).values.has(EFFORT_MEDIUM);
      const want = EFFORT_MEDIUM_MODELS.includes(k) && hasMedium ? EFFORT_MEDIUM : EFFORT_STANDARD;
      eq(e.options[keys[0]], want, `${k} ${e.provider}/${e.id} 档位`);
    }
  }
});

test("route-data: entry 与 ROUTES 行内 options 不得出现 fastMode", () => {
  for (const m of Object.values(MODELS)) for (const e of m.entries) eq("fastMode" in (e.options ?? {}), false, e.id);
  for (const cands of Object.values(ROUTES)) for (const c of cands) eq("fastMode" in (c.options ?? {}), false, c.model);
});

test("audit: 裁剪夹具上 route-data 全部入口 0 问题", () => {
  eq(auditRouteData(loadProviders(CAPS_FILE).providers), []);
});

test("validateOptions / injectOptions", () => {
  const { providers } = loadProviders(CAPS_FILE);
  eq(validateOptions("acpRegistry_devin", "swe-2-high", { thought_level: "low" }, providers).length, 1);
  eq(validateOptions("acpRegistry_devin", "swe-2-high", { thought_level: "max" }, providers), []);
  eq(injectOptions({ provider: "acpRegistry_factory_droid", id: "glm-5.3-flash", options: {} }, providers).autonomy_level, "auto-high");
  eq("fastMode" in injectOptions({ provider: "codex", id: "gpt-6.1-sol", options: {} }, providers), false);
});

// ============ 展开顺序 ============

const ids = (s) => s.map((i) => `${i.provider}/${i.id}`);

test("expandRoute: 行内顺序即声明顺序（swe-2 走 devin，其余首选 pi，备用 harness 垫后）", () => {
  eq(ids(expandRoute("general")).slice(0, 5), [
    "pi/cliproxyapi/glm-5.3-flash",
    "acpRegistry_devin/swe-2-high",
    "pi/cliproxyapi/deepseek-v4.1-flash",
    "acpRegistry_factory_droid/glm-5.3-flash",
    "acpRegistry_factory_droid/deepseek-v4.1-flash",
  ]);
  eq(ids(expandRoute("review")).slice(0, 3), ["pi/cliproxyapi/gpt-6.1-sol", "pi/cliproxyapi/grok-4.7", "codex/gpt-6.1-sol"]);
});

test("expandRoute: general 不含顾问，review 不含 opus，design 含全部顾问", () => {
  const models = (t) => new Set(expandRoute(t).map((i) => i.model));
  eq([...models("general")].sort(), ["deepseek-v4.1-flash", "glm-5.3-flash", "swe-2"]);
  eq(models("review").has("opus-5.5"), false);
  for (const k of ["opus-5.5", "gpt-6.1-sol", "grok-4.7"]) eq(models("design").has(k), true, k);
  eq(whitelistCands("general").map((c) => c.model).includes("gpt-6.1-sol"), false);
});

// ============ select ============

test("select: 各任务首选", () => {
  eq(pickOf(select(["--task", "general"])), "pi/cliproxyapi/glm-5.3-flash");
  eq(pickOf(select(["--task", "review"])), "pi/cliproxyapi/gpt-6.1-sol");
  eq(pickOf(select(["--task", "design"])), "acpRegistry_devin/claude-opus-5-5-medium");
});

test("select: --exclude 按行内顺序递补", () => {
  eq(pickOf(select(["--task", "review", "--exclude", "pi/cliproxyapi/gpt-6.1-sol"])), "pi/cliproxyapi/grok-4.7");
  eq(pickOf(select(["--task", "review", "--exclude", "pi/cliproxyapi/gpt-6.1-sol", "--exclude", "pi/cliproxyapi/grok-4.7"])), "codex/gpt-6.1-sol");
});

test("select: --exclude-model 排除同模型全部入口，且不计入换路次数", () => {
  const r = select(["--task", "review", "--exclude-model", "gpt-6.1-sol", "--json"]);
  const out = JSON.parse(r.stdout);
  eq(out.pick.modelKey, "grok-4.7");
  eq(out.attempt, 1);
  eq([out.pick, ...out.alternatives].some((p) => p.modelKey === "gpt-6.1-sol"), false);
  eq(pickOf(select(["--task", "review", "--exclude-model", "pi/cliproxyapi/gpt-6.1-sol"])), "pi/cliproxyapi/grok-4.7");
  eq(select(["--task", "review", "--exclude-model", "nope"]).status, 2);
});

test("select: pi 不可派时整体落到备用 harness", () => {
  const offPi = (d) => {
    const p = d.providers.find((x) => x.providerInstanceId === "pi");
    p.canRunChildTask = false;
    p.constraints = ["Pi is disabled"];
  };
  const r = select(["--task", "general"], offPi);
  eq(pickOf(r), "acpRegistry_devin/swe-2-high");
  if (!r.stdout.includes("Pi is disabled")) throw new Error(r.stdout);
  eq(pickOf(select(["--task", "review"], offPi)), "codex/gpt-6.1-sol");
});

test("select: --exclude-provider pi 整体落到备用 harness，计一次尝试", () => {
  const out = JSON.parse(select(["--task", "review", "--exclude-provider", "pi", "--json"]).stdout);
  eq(`${out.pick.providerInstanceId}/${out.pick.model}`, "codex/gpt-6.1-sol");
  eq(out.attempt, 2);
  eq([out.pick, ...out.alternatives].some((p) => p.providerInstanceId === "pi"), false);
});

test("select: --vision 按视觉分数降序", () => {
  eq(pickOf(select(["--task", "general", "--vision"])), "acpRegistry_devin/swe-2-high");
  eq(pickOf(select(["--task", "design", "--vision"])), "acpRegistry_devin/claude-opus-5-5-medium");
});

test("select: caps 文件超 30 分钟 → 告警且不可派判定标注过期", () => {
  const f = fixture((d) => (d.providers.find((x) => x.providerInstanceId === "pi").canRunChildTask = false));
  try {
    const old = (Date.now() - 2 * 3600e3) / 1000;
    utimesSync(f.caps, old, old);
    const r = run(["select", "--task", "general", ...f.base]);
    if (!/WARN --caps-file 是 \d+ 分钟前的快照/.test(r.stdout)) throw new Error(r.stdout);
    if (!r.stdout.includes("此判定可能已过期")) throw new Error(r.stdout);
  } finally {
    f.cleanup();
  }
});

test("select: 超过 4 次尝试上限退出 1", () => {
  const ex = ["a/1", "b/2", "c/3", "d/4"].flatMap((e) => ["--exclude", e]);
  const r = select(["--task", "general", ...ex]);
  eq(r.status, 1);
  if (!r.stdout.includes("上限")) throw new Error(r.stdout);
});

test("select: 已移除参数与任务类型退出 2，tasks 只列三个任务", () => {
  eq(select(["--task", "advisor"]).status, 2);
  eq(select(["--task", "nope"]).status, 2);
  eq(run(["select", "--hard"]).status, 2);
  eq(run(["tasks"]).stdout.trim().split("\n").map((l) => l.split(/\s+/)[0]), ["general", "design", "review"]);
});

test("select: 无 caps-file 时 pi 读 pi --list-models、其余读 T3_CACHE_DIR 并强告警", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-cache-"));
  try {
    // 陈旧 pi.json 不再参与判断
    writeFileSync(join(dir, "pi.json"), JSON.stringify({ enabled: true, status: "ready", auth: { status: "authenticated" }, models: [{ slug: "commandcode/old" }] }));
    // 只替换假 CLI 的启动边界，用 Node 启动它；避免依赖 Windows 不支持的 shebang。
    const bin = join(dir, "fake-pi.mjs");
    writeFileSync(bin, `if (process.argv[2] !== '--list-models') process.exit(2);\nconsole.log('provider model context\\ncliproxyapi glm-5.3-flash 500K\\ncliproxyapi gpt-6.1-sol 500K');\n`);
    const hook = join(dir, "launch-fixture.mjs");
    writeFileSync(hook, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawnSync;
cp.spawnSync = (cmd, args, opts) => cmd === ${JSON.stringify(bin)}
  ? spawn(process.execPath, [cmd, ...args], opts)
  : spawn(cmd, args, opts);
syncBuiltinESMExports();
`);
    const env = { ...process.env, T3_CACHE_DIR: dir, T3_PI_BIN: bin, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(hook).href}` };
    const r = run(["select", "--task", "general"], { env });
    eq(pickOf(r), "pi/cliproxyapi/glm-5.3-flash");
    if (!r.stdout.includes("降级模式")) throw new Error(r.stdout);
    // pi 不可用：pi 入口全部跳过并注明原因
    const r2 = run(["select", "--task", "general"], { env: { ...env, T3_PI_BIN: join(dir, "missing") } });
    if (pickOf(r2)?.startsWith("pi/")) throw new Error(r2.stdout);
    if (!r2.stdout.includes("--list-models` 失败")) throw new Error(r2.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============ named / 入口 ============

test("named: 点名模型按入口优先级出列并对非 named 状态告警", () => {
  const f = fixture();
  try {
    const r = run(["named", "gpt-6.1-sol", ...f.base]);
    eq(pickOf(r), "pi/cliproxyapi/gpt-6.1-sol");
    if (!r.stdout.includes("不是点名专用")) throw new Error(r.stdout);
    eq(pickOf(run(["named", "gpt-6.1-sol", "--provider", "codex", ...f.base])), "codex/gpt-6.1-sol");
    eq(run(["named", "nope", ...f.base]).status, 2);
  } finally {
    f.cleanup();
  }
});

test("入口：经符号链接调用照常执行", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "route-link-"));
  try {
    const link = join(dir, "route.mjs");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link, "tasks"], { encoding: "utf8" });
    eq(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============ playground ============

test("playground: 生成的 HTML 自包含且 JSON 块可解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-pg-"));
  try {
    for (const extra of [["--caps-file", CAPS_FILE], []]) {
      const out = join(dir, "pg.html");
      const r = spawnSync(process.execPath, [join(DIR, "route-playground.mjs"), ...extra, "-o", out], { encoding: "utf8" });
      eq(r.status, 0, r.stderr);
      const html = readFileSync(out, "utf8");
      if (html.includes("__ROUTE_DATA__") || html.includes("__CAPS__")) throw new Error("占位符未替换");
      for (const id of ["route-data", "caps-data"]) {
        const m = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
        JSON.parse(m[1]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
