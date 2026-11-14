import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cells, rank, run, summarize } from "./ui-map.mjs";

const config = { threshold: 9, batchSize: 2, platforms: ["android", "ios"], themes: ["light", "dark"], families: { phone: ["android", "ios"] } };
const never = () => [];

test("格子是 平台 × 主题 × 状态，跳过不支持的平台并标出截图缺口", () => {
  const screen = {
    id: "a", unsupported: { ios: "无此页" }, sources: { android: ["app/a"] },
    states: [{ id: "default" }, { id: "error", gaps: { android: "缺注入入口" } }], scores: [],
  };
  const list = cells(screen, config, never);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((c) => c.status), ["unscored", "gap", "unscored", "gap"]);
});

test("评分后源码有改动的格子过期，未达标优先于过期", () => {
  const screen = {
    id: "a", sources: { "*": ["shared"], android: ["app/a"] }, themes: ["light"], platforms: ["android"],
    states: [{ id: "default" }, { id: "empty" }],
    scores: [
      { platform: "android", theme: "light", state: "default", score: 9.2, commit: "c1" },
      { platform: "android", theme: "light", state: "empty", score: 7, commit: "c1" },
    ],
  };
  const changed = () => ["shared/theme.css"];
  assert.deepEqual(cells(screen, config, changed).map((c) => c.status), ["stale", "low"]);
  assert.deepEqual(cells(screen, config, () => ["shared-other/x"]).map((c) => c.status), ["ok", "low"]);
  assert.equal(cells(screen, config, () => null)[0].status, "stale");
});

test("排序：未评分 → 未达标 → 过期，同档按优先级和最低分", () => {
  const s = (id, priority, statuses, min = null) => ({ ...summarize({ id, priority }, statuses.map((status) => ({ status, score: min ?? undefined }))) });
  const ranked = rank([
    s("ok", 1, ["ok"], 9.5),
    s("stale", 1, ["stale"], 9.1),
    s("low-p2", 2, ["low"], 6),
    s("low-p1", 1, ["low"], 8),
    s("new-p3", 3, ["unscored"]),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["new-p3", "low-p1", "low-p2", "stale"]);
});

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "ui-map-"));
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app/a.kt"), "v1\n");
  writeFileSync(join(repo, "registry.json"), JSON.stringify({ pages: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }] }));
  const dir = join(repo, "skill");
  mkdirSync(join(dir, "screens"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, platforms: ["android"], themes: ["light"], families: { phone: ["android"] }, registry: { file: "registry.json", list: "pages" } }));
  writeFileSync(join(dir, "screens/a.json"), JSON.stringify({ id: "a", name: "甲", sources: { android: ["app/a.kt"] }, states: [{ id: "default" }], scores: [] }));
  g("add", ".");
  g("commit", "-qm", "init");
  const out = [];
  const cli = (...argv) => { out.length = 0; const code = run(["--dir", dir, ...argv], (l) => out.push(l)); return { code, text: out.join("\n") }; };
  return { repo, dir, g, cli };
}

test("record 写入 HEAD，源码改动后 check 提示过期；有未提交改动时拒绝记录", () => {
  const { repo, dir, g, cli } = fixture();
  cli("record", "a", "--platform", "android", "--theme", "light", "--state", "default", "--score", "9.3", "--deduction", "图标未对齐");
  const saved = JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8")).scores[0];
  assert.equal(saved.commit, g("rev-parse", "HEAD").trim());
  assert.deepEqual(saved.deductions, ["图标未对齐"]);
  assert.match(cli("next").text, /没有需要打磨/);

  writeFileSync(join(repo, "app/a.kt"), "v2\n");
  assert.throws(() => cli("record", "a", "--platform", "android", "--theme", "light", "--state", "default", "--score", "9.5"), /先提交/);
  const checked = cli("check");
  assert.equal(checked.code, 0);
  assert.match(checked.text, /a：1 格已过期/);
  assert.match(checked.text, /b：注册表里有，地图里没有/);
  assert.equal(cli("check", "--strict").code, 1);
  assert.match(cli("next").text, /## a（甲）[\s\S]*stale 9.3/);
});

test("invalidate 只把指定范围的分数标为过期，重新 record 后恢复", () => {
  const { dir, g, cli } = fixture();
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...cfg, platforms: ["android", "ios"], families: { phone: ["android", "ios"] } }));
  const screen = JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8"));
  writeFileSync(join(dir, "screens/a.json"), JSON.stringify({ ...screen, blueprint: "flow", sources: { android: ["app/a.kt"], ios: ["app/a.kt"] } }));
  g("add", ".");
  g("commit", "-qm", "two platforms");
  for (const p of ["android", "ios"]) cli("record", "a", "--platform", p, "--theme", "light", "--state", "default", "--score", "9.4");
  assert.match(cli("next").text, /没有需要打磨/);

  assert.throws(() => cli("invalidate", "--blueprint", "flow"), /--reason/);
  assert.match(cli("invalidate", "--blueprint", "flow", "--platform", "ios", "--reason", "提交按钮移到表单底部").text, /1 格标为过期/);
  const next = cli("next").text;
  assert.match(next, /ios \/ light \/ default：stale 9.4（提交按钮移到表单底部）/);
  assert.match(next, /android \/ light \/ default：ok/);

  cli("record", "a", "--platform", "ios", "--theme", "light", "--state", "default", "--score", "9.1");
  const ios = JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8")).scores.find((x) => x.platform === "ios");
  assert.equal(ios.invalidated, undefined);
  assert.match(cli("next").text, /没有需要打磨/);
});

test("按平台族筛选，next 给出同族已达标的参照平台", () => {
  const { dir, g, cli } = fixture();
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const families = { desktop: ["macos", "web"], phone: ["android", "ios"] };
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...cfg, platforms: ["macos", "web", "android", "ios"], families }));
  const screen = JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8"));
  writeFileSync(join(dir, "screens/a.json"), JSON.stringify({ ...screen, sources: { "*": ["app/a.kt"] } }));
  g("add", ".");
  g("commit", "-qm", "families");
  cli("record", "a", "--platform", "macos", "--theme", "light", "--state", "default", "--score", "9.3");

  const desktop = cli("next", "--family", "desktop").text;
  assert.match(desktop, /### 平台族 desktop  参照：macos/);
  assert.match(desktop, /web \/ light \/ default：unscored/);
  assert.doesNotMatch(desktop, /android/);
  assert.match(cli("next", "--platform", "android").text, /### 平台族 phone  参照：无/);
  assert.throws(() => cli("next", "--family", "watch"), /没有平台族 watch/);

  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...cfg, platforms: ["macos", "web"], families: { desktop: ["macos"] } }));
  assert.match(cli("check").text, /平台 web 须恰好属于一个平台族/);
});

test("sync-registry 补占位界面，config 修改阈值并校验取值", () => {
  const { dir, cli } = fixture();
  assert.match(cli("sync-registry").text, /新增 1 个占位界面：b/);
  assert.equal(JSON.parse(readFileSync(join(dir, "screens/b.json"), "utf8")).states[0].id, "default");
  cli("config", "threshold", "8.5");
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).threshold, 8.5);
  assert.throws(() => cli("config", "batchSize", "0"), /取值无效/);
  assert.throws(() => cli("config", "platforms", "x"), /只能修改/);
});

test("check 报出格式错误并以 1 退出", () => {
  const { dir, cli } = fixture();
  writeFileSync(join(dir, "screens/c.json"), JSON.stringify({ id: "wrong", states: [] }));
  const r = cli("check");
  assert.equal(r.code, 1);
  assert.match(r.text, /文件名须为 wrong.json/);
  assert.match(r.text, /states 不能为空/);
  assert.throws(() => cli("status"), /先运行 check/);
});
