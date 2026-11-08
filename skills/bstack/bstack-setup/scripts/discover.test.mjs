import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "./discover.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bstack-discover-"));
  const skills = join(root, "skills");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  const skill = (name, setup) => {
    mkdirSync(join(skills, name, "references"), { recursive: true });
    if (setup !== undefined) writeFileSync(join(skills, name, "references", "setup.md"), setup);
  };
  return { root, skills, cfg, skill, run: () => discover({ skillDirs: [skills], env: { BSTACK_CONFIG_DIR: cfg } }) };
}

const setupMd = (config, version) => `---\nconfig: ${config}\nversion: ${version}\n---\n\n# setup\n`;

test("按配置文件判定状态，没有 setup.md 的技能不列出", () => {
  const f = fixture();
  try {
    f.skill("plain");
    f.skill("a", setupMd("a.json", 2));
    f.skill("b", setupMd("b.json", 2));
    f.skill("c", setupMd("c.json", 2));
    f.skill("d", setupMd("d.json", 1));
    f.skill("e", setupMd("e.json", 1));
    f.skill("bad", "# 没有 frontmatter\n");
    writeFileSync(join(f.cfg, "b.json"), JSON.stringify({ version: 2 }));
    writeFileSync(join(f.cfg, "c.json"), JSON.stringify({ version: 1 }));
    writeFileSync(join(f.cfg, "d.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(f.cfg, "e.json"), "{ broken");
    const states = Object.fromEntries(f.run().skills.map((s) => [s.name, s.state]));
    assert.deepEqual(states, { a: "unconfigured", b: "configured", bad: "invalid", c: "outdated", d: "newer", e: "broken" });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("多个技能目录里同名技能取先找到的", () => {
  const f = fixture();
  try {
    f.skill("a", setupMd("a.json", 1));
    const other = join(f.root, "other");
    mkdirSync(join(other, "a", "references"), { recursive: true });
    writeFileSync(join(other, "a", "references", "setup.md"), setupMd("other.json", 1));
    const r = discover({ skillDirs: [f.skills, other, join(f.root, "missing")], env: { BSTACK_CONFIG_DIR: f.cfg } });
    assert.equal(r.skills.length, 1);
    assert.equal(r.skills[0].config, "a.json");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
