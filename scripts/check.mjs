#!/usr/bin/env node
// 仓库一致性检查：把「新增/修改技能必须同步更新 README」等约定机械化。
//
// 用法：node scripts/check.mjs
// 退出码：0 全部通过；1 存在不一致项。
//
// 检查项：
//   1. AGENTS.md 与 CLAUDE.md 正文一致（首行标题各自命名，忽略）；或 CLAUDE.md 仅含 `@AGENTS.md` 引用
//   2. 每个 skills/**/SKILL.md 有 frontmatter，name 与目录名一致，description 非空
//   3. 每个技能在 README.md 中有对应小节（含指向该 SKILL.md 的链接）
//   4. skills/forks/ 下的技能，其 README 小节必须注明「来源」
//   5. scripts/ 下的 .mjs/.py 工具在 README 中有链接
//   6. 带 disable-model-invocation: true 的技能，README 小节写明「仅限用户主动调用」（单向：反过来不强制）
//   7. skills/**/*.test.mjs 全部通过（node --test）
//   8. 技能脚本的主入口判断经 realpathSync 解析 argv[1]（技能常经符号链接安装，否则静默不执行）
//   9. 通用技能的正文、引用文档和脚本不得引用 bstack 技能或配置

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fails = [];
const fail = (msg) => fails.push(msg);

const readmePath = join(ROOT, "README.md");
const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
if (!readme) fail("README.md 缺失或为空");

// README 按 ### 切小节，便于做「该小节内」的断言
const sections = readme.split(/^### /m).slice(1);

// 1. AGENTS.md / CLAUDE.md 一致，或 CLAUDE.md 用 @ 引用指回 AGENTS.md
const stripH1 = (t) => t?.replace(/^#[^\n]*\n/, "");
const isRef = (t) => /^@AGENTS\.md\s*$/.test(stripH1(t)?.trim() ?? "");
const agents = existsSync(join(ROOT, "AGENTS.md")) ? readFileSync(join(ROOT, "AGENTS.md"), "utf8") : null;
const claude = existsSync(join(ROOT, "CLAUDE.md")) ? readFileSync(join(ROOT, "CLAUDE.md"), "utf8") : null;
if (agents === null || claude === null) fail("AGENTS.md 或 CLAUDE.md 缺失");
else if (stripH1(agents) !== stripH1(claude) && !isRef(claude)) fail("AGENTS.md 与 CLAUDE.md 正文不一致（首行标题各自命名，不计）");

// 2-4. 技能检查
function* walk(dir, depth = 0) {
  if (depth > 5) return;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "SKILL.md"))) yield p;
    else yield* walk(p, depth + 1);
  }
}

let skillCount = 0;
const skillsDir = join(ROOT, "skills");
for (const dir of walk(skillsDir)) {
  skillCount++;
  const rel = relative(ROOT, dir).split(sep).join("/");
  const name = dir.split(sep).at(-1);
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    fail(`${rel}/SKILL.md：缺少 frontmatter`);
  } else {
    const fmName = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const fmDesc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!fmName) fail(`${rel}/SKILL.md：frontmatter 缺 name`);
    else if (fmName !== name) fail(`${rel}/SKILL.md：name "${fmName}" 与目录名 "${name}" 不一致`);
    if (!fmDesc) fail(`${rel}/SKILL.md：frontmatter 缺 description`);
  }

  const link = `(${rel}/SKILL.md)`;
  const section = sections.find((s) => s.includes(link));
  if (!section) {
    fail(`${rel}：README.md 没有指向 ${rel}/SKILL.md 的链接`);
  } else if (rel.startsWith("skills/forks/") && !/来源[:：]/.test(section)) {
    fail(`${rel}：分叉技能的 README 小节缺少「来源」标注`);
  }

  const userInvokedOnly = /^disable-model-invocation:\s*true\s*$/m.test(fm?.[1] ?? "");
  if (userInvokedOnly && section && !/仅限用户主动调用/.test(section)) {
    fail(`${rel}：带 disable-model-invocation 的技能，README 小节要写明「仅限用户主动调用」`);
  }
}

// 5. 根 scripts/ 工具登记
const scriptsDir = join(ROOT, "scripts");
for (const f of readdirSync(scriptsDir)) {
  if (!/\.(mjs|py|sh)$/.test(f)) continue;
  const rel = `scripts/${f}`;
  if (!readme.includes(rel)) fail(`${rel}：README.md 的工具脚本小节没有登记`);
}

// 6. 技能脚本测试
function* walkFiles(dir, accept, depth = 0) {
  if (depth > 6) return;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      yield* walkFiles(p, accept, depth + 1);
      continue;
    }
    if (accept(e)) yield p;
  }
}
const testFiles = [...walkFiles(skillsDir, (e) => e.endsWith(".test.mjs"))];
if (testFiles.length) {
  const r = spawnSync(process.execPath, ["--test", ...testFiles], { encoding: "utf8" });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-30).join("\n");
    fail(`脚本测试未通过（${testFiles.length} 个测试文件）：\n${out}`);
  }
}

// 8. 主入口判断：import.meta.url 是真实路径，argv[1] 可能是符号链接（~/.config/devin/skills/* → ~/.agents/skills/*）
const MAIN_GUARD = /import\.meta\.url\s*===\s*pathToFileURL\(\s*(?!realpathSync\()/;
for (const p of walkFiles(skillsDir, (e) => /\.m?js$/.test(e))) {
  const lines = readFileSync(p, "utf8").split("\n");
  const i = lines.findIndex((l) => MAIN_GUARD.test(l));
  if (i >= 0) fail(`${relative(ROOT, p).split(sep).join("/")}:${i + 1}：主入口判断须写成 \`import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href\`（realpathSync 来自 node:fs），否则经符号链接调用时静默不执行`);
}

// 9. 单向依赖：从目录发现体系技能名，覆盖正文、disclosed reference 与脚本。
const bstackNames = [...walk(join(skillsDir, "bstack"))].map((dir) => dir.split(sep).at(-1));
const escapedNames = bstackNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const bstackReference = new RegExp(`(?:^|[^a-z0-9_-])(?:${escapedNames.join("|")})(?=$|[^a-z0-9_-])`, "i");
const bstackPath = /(?:skills|\.config)[\\/]+bstack\b/i;
for (const p of walkFiles(join(skillsDir, "general"), (e) => /\.(?:md|m?js|cjs|ts|json|py|sh|ya?ml|txt)$/.test(e))) {
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (bstackReference.test(line) || bstackPath.test(line)) fail(`${relative(ROOT, p).split(sep).join("/")}:${i + 1}：通用技能不得依赖或引用 bstack 技能或配置`);
  });
}

if (fails.length) {
  console.log(`检查未通过（${fails.length} 项）：`);
  for (const f of fails) console.log(`- ${f}`);
  process.exit(1);
}
console.log(`检查通过：${skillCount} 个技能、AGENTS/CLAUDE 一致、scripts 已登记、${testFiles.length} 个测试文件全绿。`);
