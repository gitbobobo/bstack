#!/usr/bin/env node
// 生成 route-playground.html：route.mjs 路由规则的可视化沙盒。
// 固定输入 → 固定输出的可视化版本；用来人工搭配输入、检查路由表哪里有问题。
//
//   node route-playground.mjs [--caps-file caps.json] [-o out.html]
//
// 数据快照默认是合成的（全部实例可用），供纯规则调试；--caps-file 传
// orchestrator_capabilities 的 JSON 后，沙盒按真实状态初始化（仍可手动改）。
//
// 生成的 HTML 完全自包含，双击即可在浏览器打开（file:// 也行）。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROVIDER_RULES, MODELS, TASKS, ADVISOR_TASKS, ROUTES, MAX_ATTEMPTS } from "./route-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      o[key] = argv[++i];
    } else if (a === "-o") o.o = argv[++i];
    else o._.push(a);
  }
  return o;
}

// ---------- capabilities 快照 ----------

// 沙盒只需要：实例是否可派子任务、约束文案、路由表引用到的模型 id 及其选项名
function slimCaps(providers) {
  const wanted = new Map(); // providerId -> Set(modelIds)
  for (const m of Object.values(MODELS))
    for (const e of m.entries) (wanted.get(e.provider) ?? wanted.set(e.provider, new Set()).get(e.provider)).add(e.id);
  return {
    providers: providers
      .filter((p) => wanted.has(p.providerInstanceId ?? p.id))
      .map((p) => {
        const id = p.providerInstanceId ?? p.id;
        const ids = wanted.get(id);
        return {
          id,
          canRunChildTask: p.canRunChildTask !== false,
          constraints: p.constraints ?? [],
          models: (p.models ?? []).filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, options: (m.options ?? []).map((o) => o.id ?? o) })),
        };
      }),
  };
}

// 没有 --caps-file 时合成：全部实例可派、模型清单=路由表引用的 id、选项空
function synthCaps() {
  const map = new Map();
  for (const m of Object.values(MODELS))
    for (const e of m.entries) (map.get(e.provider) ?? map.set(e.provider, new Set()).get(e.provider)).add(e.id);
  return {
    providers: [...map].map(([id, ids]) => ({ id, canRunChildTask: true, constraints: [], models: [...ids].map((i) => ({ id: i, options: [] })) })),
  };
}

// ---------- 主流程 ----------

const opts = parseArgs(process.argv.slice(2));
const table = { PROVIDER_RULES, MODELS, TASKS, ADVISOR_TASKS, ROUTES, MAX_ATTEMPTS };

let caps;
if (opts["caps-file"]) {
  caps = slimCaps(JSON.parse(readFileSync(opts["caps-file"], "utf8")).providers ?? []);
} else {
  caps = synthCaps();
  console.error("# 未传 --caps-file：沙盒按「全部实例可派」初始化，手动勾选即可模拟不可用");
}

const template = readFileSync(join(here, "route-playground.template.html"), "utf8");
const inject = (s) => s.replace(/<\//g, "<\\/"); // 防 JSON 里的 </script> 提前闭合
const html = template
  .replace("__ROUTE_DATA__", () => inject(JSON.stringify(table, null, 1)))
  .replace("__CAPS__", () => inject(JSON.stringify(caps, null, 1)));

const out = resolve(opts.o ?? join(here, "route-playground.html"));
writeFileSync(out, html);
console.log(`已生成 ${out}（${(html.length / 1024).toFixed(1)}KB），直接用浏览器打开即可`);
