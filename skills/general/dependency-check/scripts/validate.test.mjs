import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function mdFiles() {
  return [...walk(skillDir)].filter((p) => p.endsWith(".md"));
}

function textOf(p) {
  return readFileSync(p, "utf8");
}

test("frontmatter 与目录名一致，description 非空", () => {
  const text = textOf(join(skillDir, "SKILL.md"));
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, "SKILL.md 必须有 frontmatter");
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(name, "dependency-check");
  assert.ok(desc && desc.length > 10, "description 不能为空");
  assert.match(desc, /依赖检查/);
});

test("相对链接都能落到技能目录内的文件", () => {
  for (const file of mdFiles()) {
    const text = textOf(file);
    const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    for (const href of links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
      const dest = join(dirname(file), href.split("#")[0]);
      assert.ok(existsSync(dest), `${relative(skillDir, file)} 中的链接不存在: ${href}`);
    }
  }
});

test("没有启动器/调度/运行框架，也没有凭证或本机路径", () => {
  const forbiddenPath = /\/home\/box\b|\/tmp\/scan\b|agent-data\/code-bot|repos\.json/;
  const forbiddenSecret = /(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*['\"]?[^'\"\s]+/i;
  const forbiddenUuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const hardcodedRepos = /gitbobobo\/(?:musiver|hago|fast_ship|gallery3d|skills|bstack)|liuyincs\/(?:tma|payment|liuyin|tma-plugins-official)/;
  const framework = /grok-launch|SCAN_WEBHOOK|setsid\s+nohup|cron\b|webhook\.done|manifest\.json/;
  for (const file of mdFiles()) {
    const rel = relative(skillDir, file);
    const text = textOf(file);
    assert.doesNotMatch(text, forbiddenPath, `${rel} 不得写死本机路径`);
    assert.doesNotMatch(text, forbiddenSecret, `${rel} 不得出现凭证赋值`);
    assert.doesNotMatch(text, forbiddenUuid, `${rel} 不得写死 UUID`);
    assert.doesNotMatch(text, hardcodedRepos, `${rel} 不得写死用户仓库`);
    assert.doesNotMatch(text, framework, `${rel} 不得带扫描启动或调度框架`);
  }
});

test("准则与建单保留分档、只读和授权要求", () => {
  const skill = textOf(join(skillDir, "SKILL.md"));
  const criteria = textOf(join(skillDir, "references", "criteria.md"));
  const filing = textOf(join(skillDir, "references", "filing.md"));
  const ecosystems = textOf(join(skillDir, "references", "ecosystems.md"));
  for (const label of ["立即升级", "可以升级", "暂不动", "未核验"]) {
    assert.match(criteria, new RegExp(label));
    assert.match(skill, new RegExp(label));
  }
  assert.match(skill, /\$fast-ship/);
  assert.match(skill, /本轮用户明确授权/);
  assert.match(skill, /不改被扫仓库/);
  assert.match(filing, /## 现状/);
  assert.match(filing, /## 证据/);
  assert.match(filing, /## 影响/);
  assert.match(filing, /## 建议/);
  assert.match(filing, /## 验收标准/);
  assert.match(filing, /## 来源/);
  assert.match(filing, /仍开放的 issue/);
  assert.match(filing, /已关闭的 issue/);
  assert.match(filing, /当天已经新建/);
  assert.match(filing, /每创建一张之前，再查一次/);
  assert.match(ecosystems, /禁止/);
  assert.match(ecosystems, /只读/);
});
