import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillDir = resolveSkillDir();
const rulesPath = join(skillDir, "references", "rules.yml");

function resolveSkillDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

function parseRules(text) {
  assert.match(text, /^# /m, "文件应有说明注释");
  assert.match(text, /^rules:\s*$/m, "顶层必须是 rules 列表");
  const chunks = text.split(/^- id: /m).slice(1);
  assert.ok(chunks.length > 0, "至少有一条规则");
  return chunks.map((chunk, i) => {
    const id = chunk.match(/^(\S+)/)?.[1];
    assert.ok(id, `第 ${i + 1} 条规则缺少 id`);
    const languages = chunk.match(/^\s*languages:\s*\[([^\]]+)\]/m)?.[1];
    const severity = chunk.match(/^\s*severity:\s*(\S+)/m)?.[1];
    const message = chunk.match(/^\s*message:\s*(.+)$/m)?.[1];
    const hasPattern = /^\s*pattern(?:s|-either|-inside|-not-inside)?:/m.test(chunk)
      || /^\s*pattern:\s+/m.test(chunk);
    return { id, languages, severity, message, hasPattern, chunk };
  });
}

test("rules.yml 结构完整且 id 唯一", () => {
  const text = readFileSync(rulesPath, "utf8");
  const rules = parseRules(text);
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `id 必须唯一: ${ids.join(", ")}`);
  for (const r of rules) {
    assert.ok(r.languages && r.languages.trim(), `${r.id} 缺少 languages`);
    assert.ok(r.severity, `${r.id} 缺少 severity`);
    assert.ok(r.message && r.message.trim(), `${r.id} 缺少 message`);
    assert.ok(r.hasPattern, `${r.id} 缺少 pattern / patterns`);
    assert.doesNotMatch(r.chunk, /(api[_-]?key|secret|token|password)\s*[:=]/i, `${r.id} 不得硬编码密钥`);
  }
});

test("semgrep 若可用则规则可被校验", () => {
  const found = spawnSync("semgrep", ["--version"], { encoding: "utf8" });
  if (found.status !== 0 && found.error) {
    return;
  }
  if (found.status !== 0) {
    return;
  }
  const r = spawnSync("semgrep", ["validate", rulesPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `semgrep validate 失败:\n${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /valid|6 rule/i);
});
