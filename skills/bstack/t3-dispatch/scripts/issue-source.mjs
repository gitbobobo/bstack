#!/usr/bin/env node
// 问题来源统一入口：派活只经这里读写问题，换来源不改派活流程。
//
// 用法（--repo 取 t3-dispatch.json 里 repos[].repo）：
//   node issue-source.mjs ensure-labels --repo <key> [--check 1]   补齐标签目录；--check 1 只读
//   node issue-source.mjs list    --repo <key> [--excerpt 400]       可派的候选与跳过原因（--excerpt 0 不带正文摘要；派过 limits.maxAttempts 次的跳过）
//   node issue-source.mjs show    --repo <key> --id <问题 ID>         单条详情（正文、共识、PR）
//   node issue-source.mjs claim   --repo <key> --id <问题 ID>         认领（Fast Ship 置 in_progress），记入派活台账；输出带认领时间 at
//   node issue-source.mjs release --repo <key> --id <问题 ID>         归还到认领前的状态（已推进或有 PR 的不改），记入台账
//   node issue-source.mjs render  --repo <key> --id <问题 ID> [--reason-file <文件>]
//                                                                    按 repos[].template 渲染派活提示词
//   node issue-source.mjs record  --repo <key> --id <问题 ID> --env <environmentId> --thread <threadId>
//                                                                    记下派出的线程
//   node issue-source.mjs ledger  [--hours 24]                        最近的台账与派出数（perDay 节流用，perDay 为 0 不限）
// 输出 JSON；失败时 stderr 给原因、退出码 1，用法错误退出码 2。
// 推荐理由含中文时写进 UTF-8 文件再用 --reason-file 传，不进命令行。
//
// 模板查找顺序：~/.config/bstack/templates/<名>.md，再到 references/templates/<名>.md；正文里的 {{source_block}} 换成来源附加块。
// 台账在 ~/.config/bstack/state/t3-dispatch.jsonl，只在本机（state/ 不进配置仓库）。
// FAST_SHIP_API 可改 fast-ship-api.mjs 的路径（测试用），缺省取同级安装的 fast-ship 技能。

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../../t3-patrol/scripts/patrol-config.mjs";
import { loadConfig } from "./dispatch-config.mjs";
import * as fastShip from "./sources/fast-ship.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTERS = { "fast-ship": fastShip };

export const ledgerPath = (env = process.env) => join(configDir(env), "state", "t3-dispatch.jsonl");

export function appendLedger(entry, env = process.env) {
  const file = ledgerPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const record = { at: new Date().toISOString(), ...entry };
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function readLedger(env = process.env) {
  const file = ledgerPath(env);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

// 每个问题取最后一条台账：claimed 后没有 launched/released 的是「认领了但没派出」，需要对账。
export function ledgerSummary(entries, { hours = 24, now = Date.now() } = {}) {
  const since = now - hours * 3600 * 1000;
  const recent = entries.filter((e) => Date.parse(e.at) >= since);
  const last = new Map();
  for (const e of entries) last.set(`${e.repo}#${e.id}`, e);
  return {
    hours,
    launched: recent.filter((e) => e.event === "launched").length,
    pending: [...last.values()].filter((e) => e.event === "claimed"),
    active: [...last.values()].filter((e) => e.event === "launched"),
    recent,
  };
}

export function findTemplate(name, env = process.env) {
  for (const p of [join(configDir(env), "templates", `${name}.md`), join(SKILL_DIR, "references", "templates", `${name}.md`)]) {
    if (existsSync(p)) return { path: p, text: readFileSync(p, "utf8").replace(/^\uFEFF/, "") };
  }
  throw new Error(`找不到模板 ${name}（${join(configDir(env), "templates")} 与技能自带模板里都没有）`);
}

export function renderMessage(template, block) {
  if (!template.includes("{{source_block}}")) throw new Error("模板缺少 {{source_block}} 占位符");
  return template.replace("{{source_block}}", block).trim();
}

function defaultApi(env) {
  const script = env.FAST_SHIP_API || join(dirname(SKILL_DIR), "fast-ship", "scripts", "fast-ship-api.mjs");
  if (!existsSync(script)) throw new Error(`找不到 ${script}（先安装 fast-ship 技能）`);
  return fastShip.cliApi(script);
}

export function run(cmd, opts, { env = process.env, api } = {}) {
  if (cmd === "ledger") return ledgerSummary(readLedger(env), { hours: Number(opts.hours ?? 24) });
  const { config, warnings, errors } = loadConfig({ env });
  if (errors.length) throw new Error(errors.join("；"));
  const repoCfg = config.repos.find((r) => r.repo === String(opts.repo ?? "").toLowerCase());
  if (!repoCfg) throw new Error(`t3-dispatch.json 的 repos 里没有 ${opts.repo}${warnings.length ? `（配置警告：${warnings.join("；")}）` : ""}`);
  const src = ADAPTERS[repoCfg.source];
  const call = api ?? defaultApi(env);
  const need = (k) => {
    if (!opts[k]) throw new Error(`${cmd} 需要 --${k}`);
    return opts[k];
  };
  const base = { repo: repoCfg.repo, source: repoCfg.source };
  switch (cmd) {
    case "ensure-labels":
      return src.ensureLabels(call, { ...repoCfg, checkOnly: opts.check === "1" });
    case "list": {
      const r = src.list(call, { ...repoCfg, trustedUsers: config.trustedUsers, excerpt: Number(opts.excerpt ?? 400) });
      const attempts = new Map();
      for (const e of readLedger(env)) if (e.repo === repoCfg.repo && e.event === "launched") attempts.set(e.id, (attempts.get(e.id) ?? 0) + 1);
      const candidates = [];
      for (const c of r.candidates) {
        const n = attempts.get(c.id) ?? 0;
        if (n >= config.limits.maxAttempts) r.skipped.push({ ref: c.ref, title: c.title, reason: `已派过 ${n} 次（limits.maxAttempts）` });
        else candidates.push(n ? { ...c, attempts: n } : c);
      }
      return { ...r, candidates, warnings };
    }
    case "show":
      return src.show(call, { id: need("id") });
    case "claim": {
      const r = src.claim(call, { id: need("id"), statuses: repoCfg.statuses });
      const { at } = appendLedger({ event: "claimed", ...base, id: r.id, ref: r.ref, prevStatus: r.prevStatus }, env);
      return { ...r, at };
    }
    case "release": {
      const id = need("id");
      const prev = [...readLedger(env)].reverse().find((e) => e.repo === repoCfg.repo && e.id === id && e.event === "claimed")?.prevStatus;
      const r = src.release(call, { id, to: prev ?? repoCfg.statuses.at(-1) });
      // 没归还也记一笔 retired：这条派活已了结，不再出现在 active 里等对账。
      appendLedger(r.released ? { event: "released", ...base, id, ref: r.ref, to: r.status } : { event: "retired", ...base, id, ref: r.ref, status: r.status, reason: r.reason }, env);
      return r;
    }
    case "render": {
      const issue = src.show(call, { id: need("id") });
      const reason = opts["reason-file"] ? readFileSync(opts["reason-file"], "utf8").replace(/^\uFEFF/, "") : null;
      const tpl = findTemplate(repoCfg.template, env);
      return { ref: issue.ref, template: tpl.path, message: renderMessage(tpl.text, src.sourceBlock({ projectId: issue.projectId, id: issue.id, reason })) };
    }
    case "record": {
      const entry = { event: "launched", ...base, id: need("id"), environmentId: need("env"), threadId: need("thread") };
      appendLedger(entry, env);
      return entry;
    }
    default:
      throw Object.assign(new Error(`未知命令 ${cmd}`), { usage: true });
  }
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined) throw Object.assign(new Error(`参数有误：${rest[i]}`), { usage: true });
    opts[rest[i].slice(2)] = rest[++i];
  }
  return { cmd, opts };
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { cmd, opts } = parseArgs(process.argv.slice(2));
    if (!cmd) throw Object.assign(new Error("缺少命令"), { usage: true });
    console.log(JSON.stringify(run(cmd, opts), null, 1));
  } catch (e) {
    console.error(`${e.message}${e.usage ? "\n用法：node issue-source.mjs <ensure-labels|list|show|claim|release|render|record|ledger> --repo <key> [--id <问题 ID>] …" : ""}`);
    process.exit(e.usage ? 2 : 1);
  }
}
