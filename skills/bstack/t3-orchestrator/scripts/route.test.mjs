// route.mjs 行为测试：两类池的展开/过滤顺序、check 的硬性规则、named 的点名放行。
// 运行：node --test route.test.mjs
// 固定输入固定输出：caps 用 fixture，不触网不读本机缓存。
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { MODELS, IMPLEMENTERS, ADVISORS, EFFORT_KEYS } from "./route-data.mjs";

// 本机 ~/.config/bstack/t3-orchestrator.json 不能影响默认路由的断言：先指向空目录再加载 route.mjs，子进程继承该变量。
process.env.BSTACK_CONFIG_DIR = mkdtempSync(join(tmpdir(), "route-cfg-"));
const { expandRoute, loadProviders, validateOptions, buildOptions, auditRouteData } = await import("./route.mjs");

const DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(DIR, "route.mjs");
const CAPS_FILE = join(DIR, "fixtures", "caps-trimmed.json");

// caps fixture：实时 orchestrator_capabilities 裁剪到 route-data 用到的 provider/模型，
// canRunChildTask 归一化为 true。重新生成方法见 references/models.md。
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
const pickOf = (r) => {
  const m = `${r.stdout}`.match(/^PICK \S+ (\{.*\})$/m);
  if (!m) return null;
  const t = JSON.parse(m[1]);
  return `${t.providerInstanceId}/${t.model}`;
};
const select = (args, mutate) => {
  const f = fixture(mutate);
  try {
    return run([...args, ...f.base]);
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
const opt = (o) => ["--options", JSON.stringify(o)];

test("check: 清单外组合非点名恒红、用户点名降级 warn", () => {
  fail(["--provider", "codex", "--model", "gpt-6-astra"], "入口清单");
  fail(["--provider", "pi", "--model", "opencode-go/glm-5.3-flash"], "入口清单");
  ok(["--provider", "pi", "--model", "cliproxyapi/grok-4.6", "--user-named"]);
});

test("check: 快速模式恒红", () => {
  fail(["--provider", "pi", "--model", "cliproxyapi/glm-5.3-flash", ...opt({ thinking: "high", fastMode: true })], "fastMode");
  fail(["--provider", "codex", "--model", "gpt-6.2-sol", ...opt({ reasoningEffort: "medium", serviceTier: "priority" })], "priority");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "gpt-6-sol-fast", ...opt({ autonomy_level: "auto-high" }), "--user-named"], "-fast");
});

test("check: 顾问只做 review/design，点名专用模型须 --user-named", () => {
  const gpt = ["--provider", "pi", "--model", "cliproxyapi/gpt-6.2-sol", ...opt({ thinking: "medium" })];
  fail([...gpt, "--role", "implementation"], "顾问");
  ok([...gpt, "--role", "review"]);
  ok([...gpt, "--role", "implementation", "--user-named"]);
  const opus = ["--provider", "acpRegistry_devin", "--model", "claude-opus-5-5-medium", ...opt({ thought_level: "medium" })];
  fail([...opus, "--role", "design"], "仅限用户点名");
  ok([...opus, "--role", "implementation", "--user-named"]);
});

test("check: 思考强度固定，缺省或改档都拦", () => {
  const swe = ["--provider", "acpRegistry_devin", "--model", "swe-2-high", "--role", "implementation"];
  fail(swe, "思考强度固定");
  fail([...swe, ...opt({ thought_level: "max" })], "思考强度固定");
  ok([...swe, ...opt({ thought_level: "high" })]);
  fail(["--provider", "pi", "--model", "cliproxyapi/deepseek-v4.1-flash", ...opt({ thinking: "high" })], "thinking=medium");
});

test("check: droid 选项名与 autonomy_level", () => {
  const glm = ["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash"];
  fail([...glm, ...opt({ reasoning_effort: "high" })], "autonomy_level");
  fail([...glm, ...opt({ autonomy_level: "auto-high", reasoning_effort: "high", reasoningEffort: "high" })], "snake_case");
  ok([...glm, ...opt({ autonomy_level: "auto-high", reasoning_effort: "high" })]);
});

test("check --caps-file: 选项按目录校验；Devin 暂缺档位时拒绝，完整目录下通过", () => {
  // 回放 2026-11-14 12:19Z 的 Unknown option thought_level; supported options: mode。
  const f = fixture((caps) => {
    const devin = caps.providers.find((p) => p.providerInstanceId === "acpRegistry_devin");
    devin.models.find((m) => m.id === "swe-2-high").options = [{ id: "mode", type: "select", options: [{ id: "bypass" }] }];
  });
  try {
    const base = ["--provider", "acpRegistry_devin", "--model", "swe-2-high", ...opt({ thought_level: "high", mode: "bypass" })];
    fail([...base, ...f.base], "无选项 thought_level");
    ok([...base, "--caps-file", CAPS_FILE]);
  } finally {
    f.cleanup();
  }
});

// ============ route-data 不变量 ============

test("route-data: 两类池（用户定 2026-11-22）与固定档位", () => {
  eq(IMPLEMENTERS, ["glm-5.3-flash", "swe-2", "deepseek-v4.1-flash"]);
  eq(ADVISORS, ["gpt-6.2-sol"]);
  const effort = Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.effort]));
  eq(effort, { "glm-5.3-flash": "high", "swe-2": "high", "deepseek-v4.1-flash": "medium", "gpt-6.2-sol": "medium", "opus-5.5": "medium", "grok-4.7": "medium" });
});

test("route-data: 首选入口（用户定 2026-11-04）：swe-2 只走 devin，opus 从 devin/droid 选，其余首选 pi", () => {
  eq(MODELS["swe-2"].entries.map((e) => e.provider), ["acpRegistry_devin"]);
  eq(MODELS["opus-5.5"].entries.map((e) => e.provider), ["acpRegistry_devin", "acpRegistry_factory_droid"]);
  for (const [k, m] of Object.entries(MODELS)) if (k !== "swe-2" && k !== "opus-5.5") eq(m.entries[0].provider, "pi", k);
});

test("route-data: 入口不自带档位与 fastMode，档位全部由 effort 注入", () => {
  for (const m of Object.values(MODELS)) {
    for (const e of m.entries) {
      eq(Object.keys(e.options ?? {}).filter((k) => k === "fastMode" || Object.values(EFFORT_KEYS).includes(k)), [], e.id);
      if (!EFFORT_KEYS[e.provider]) throw new Error(`${e.provider} 未登记档位选项名`);
    }
  }
});

test("audit: 裁剪夹具上全部入口 0 问题", () => {
  eq(auditRouteData(loadProviders(CAPS_FILE).providers), []);
});

test("validateOptions / buildOptions", () => {
  const { providers } = loadProviders(CAPS_FILE);
  eq(validateOptions("acpRegistry_devin", "swe-2-high", { thought_level: "low" }, providers).length, 1);
  eq(buildOptions("glm-5.3-flash", MODELS["glm-5.3-flash"].entries[1], providers), { reasoning_effort: "high", autonomy_level: "auto-high" });
  eq(buildOptions("gpt-6.2-sol", MODELS["gpt-6.2-sol"].entries[1], providers), { reasoningEffort: "medium" });
});

// ============ 展开顺序 ============

const ids = (s) => s.map((i) => `${i.entry.provider}/${i.entry.id}`);

test("expandRoute: 先排各模型首选入口，再排备用 harness；advisor 用尽顾问后递补实现池", () => {
  const impl = ["pi/cliproxyapi/glm-5.3-flash", "acpRegistry_devin/swe-2-high", "pi/cliproxyapi/deepseek-v4.1-flash", "acpRegistry_factory_droid/glm-5.3-flash", "acpRegistry_factory_droid/deepseek-v4.1-flash"];
  eq(ids(expandRoute("impl")), impl);
  eq(ids(expandRoute("advisor")), ["pi/cliproxyapi/gpt-6.2-sol", "codex/gpt-6.2-sol", "acpRegistry_factory_droid/gpt-6.2-sol", ...impl]);
  eq([...new Set(expandRoute("advisor").map((i) => i.via))], ["advisor", "fallback"]);
  for (const k of ["impl", "advisor"]) eq(expandRoute(k).some((i) => ["opus-5.5", "grok-4.7"].includes(i.modelKey)), false, k);
});

// ============ impl / advisor ============

test("impl/advisor: 首选与 --exclude 递补", () => {
  eq(pickOf(select(["impl"])), "pi/cliproxyapi/glm-5.3-flash");
  eq(pickOf(select(["advisor"])), "pi/cliproxyapi/gpt-6.2-sol");
  eq(pickOf(select(["impl", "--exclude", "pi/cliproxyapi/glm-5.3-flash"])), "acpRegistry_devin/swe-2-high");
  eq(pickOf(select(["advisor", "--exclude", "pi/cliproxyapi/gpt-6.2-sol"])), "codex/gpt-6.2-sol");
});

test("advisor: --exclude-model 排除顾问后从实现池递补，且不计入换路次数", () => {
  const r = select(["advisor", "--exclude-model", "gpt-6.2-sol"]);
  eq(pickOf(r), "pi/cliproxyapi/glm-5.3-flash");
  if (!r.stdout.includes("取自实现池")) throw new Error(r.stdout);
  const out = JSON.parse(select(["advisor", "--exclude-model", "pi/cliproxyapi/gpt-6.2-sol", "--json"]).stdout);
  eq([out.pick.modelKey, out.attempt], ["glm-5.3-flash", 1]);
  eq(select(["advisor", "--exclude-model", "nope"]).status, 2);
});

test("impl: pi 不可派时落到其他 harness，跳过原因只列 PICK 之前的", () => {
  const r = select(["impl"], (d) => {
    const p = d.providers.find((x) => x.providerInstanceId === "pi");
    p.canRunChildTask = false;
    p.constraints = ["Pi is disabled"];
  });
  eq(pickOf(r), "acpRegistry_devin/swe-2-high");
  eq(r.stdout.match(/^SKIPPED /gm).length, 1, r.stdout);
  if (!r.stdout.includes("Pi is disabled")) throw new Error(r.stdout);
});

test("advisor: --exclude-provider pi 计一次尝试", () => {
  const out = JSON.parse(select(["advisor", "--exclude-provider", "pi", "--json"]).stdout);
  eq(out.pick.target.providerInstanceId, "codex");
  eq(out.attempt, 2);
  eq([out.pick, ...out.next].some((p) => p.target.providerInstanceId === "pi"), false);
});

test("impl: caps 文件超 30 分钟告警并标注过期", () => {
  const f = fixture((d) => (d.providers.find((x) => x.providerInstanceId === "pi").canRunChildTask = false));
  try {
    const old = (Date.now() - 2 * 3600e3) / 1000;
    utimesSync(f.caps, old, old);
    const r = run(["impl", ...f.base]);
    if (!/WARN --caps-file 是 \d+ 分钟前的快照/.test(r.stdout) || !r.stdout.includes("可能失效")) throw new Error(r.stdout);
  } finally {
    f.cleanup();
  }
});

test("impl: 超过 4 次尝试上限退出 1；旧 select 用法退出 2", () => {
  const r = select(["impl", ...["a/1", "b/2", "c/3", "d/4"].flatMap((e) => ["--exclude", e])]);
  eq(r.status, 1);
  if (!r.stdout.includes("上限")) throw new Error(r.stdout);
  eq(run(["select", "--task", "general"]).status, 2);
});

test("impl: 无 caps-file 时 pi 读 pi --list-models、其余读 T3_CACHE_DIR 并强告警", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-cache-"));
  try {
    // 陈旧 pi.json 不再参与判断
    writeFileSync(join(dir, "pi.json"), JSON.stringify({ enabled: true, status: "ready", auth: { status: "authenticated" }, models: [{ slug: "commandcode/old" }] }));
    // 只替换假 CLI 的启动边界，用 Node 启动它；避免依赖 Windows 不支持的 shebang。
    const bin = join(dir, "fake-pi.mjs");
    writeFileSync(bin, `if (process.argv[2] !== '--list-models') process.exit(2);\nconsole.log('provider model context\\ncliproxyapi glm-5.3-flash 500K\\ncliproxyapi gpt-6.2-sol 500K');\n`);
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
    const r = run(["impl"], { env });
    eq(pickOf(r), "pi/cliproxyapi/glm-5.3-flash");
    if (!r.stdout.includes("降级模式")) throw new Error(r.stdout);
    const r2 = run(["impl"], { env: { ...env, T3_PI_BIN: join(dir, "missing") } });
    if (pickOf(r2)?.startsWith("pi/")) throw new Error(r2.stdout);
    if (!r2.stdout.includes("--list-models` 失败")) throw new Error(r2.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============ named / 入口 ============

test("named: 点名模型按入口优先级出列，带固定档位", () => {
  const f = fixture();
  try {
    eq(pickOf(run(["named", "opus", ...f.base])), "acpRegistry_devin/claude-opus-5-5-medium");
    eq(pickOf(run(["named", "grok-4.7", ...f.base])), "pi/cliproxyapi/grok-4.7");
    eq(pickOf(run(["named", "gpt-6.2-sol", "--provider", "codex", ...f.base])), "codex/gpt-6.2-sol");
    eq(JSON.parse(run(["named", "grok-4.7", "--json", ...f.base]).stdout).pick.target.options, { thinking: "medium" });
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
    eq(spawnSync(process.execPath, [link, "table"], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
