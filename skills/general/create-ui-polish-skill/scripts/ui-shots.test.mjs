import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { LABEL, MAX_EDGE, defaultBuild, ffmpegArgs, layout, readImage, run } from "./ui-shots.mjs";
import { run as mapRun } from "./ui-map.mjs";

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

// 灰度 PNG：前 topRows 行取 top 的灰度（模拟状态栏），filter 为 2 时按 Up 滤波编码。
function png(width, height, gray, text, { top = gray, topRows = 0, filter = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const raw = (y) => (y < topRows ? top : gray);
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = filter;
    const v = filter === 2 && y > 0 ? (raw(y) - raw(y - 1)) & 0xff : raw(y);
    rows.fill(v, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), ...(text ? [chunk("tEXt", Buffer.from(text))] : []),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SCOPE = "### 打磨范围：a\n\n锁定：\n- 区块顺序\n\n可调：\n- 标题间距，±50% 以内\n";
const blueprint = (scope) => `# flow：测试\n\n## 共通\n\n### 产品约束\n\n- 收藏圆点表示同步状态\n\n## 布局：phone\n\n平台：phone-a\n\n标题在上，列表在下。\n\n${scope ? SCOPE : ""}\n## 决定记录\n\n- 初始\n`;

function fixture({ themes = ["light", "dark"], states = [{ id: "default" }, { id: "empty" }], scoped = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "ui-shots-"));
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app/a.kt"), "v1\n");
  const dir = join(repo, "skill");
  mkdirSync(join(dir, "screens"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ threshold: 9, batchSize: 3, platforms: ["phone-a"], themes, families: { phone: ["phone-a"] } }));
  writeFileSync(join(dir, "screens/a.json"), JSON.stringify({ id: "a", name: "甲", blueprint: "flow", sources: { "phone-a": ["app/a.kt"] }, states, scores: [] }));
  mkdirSync(join(dir, "blueprints"));
  writeFileSync(join(dir, "blueprints/flow.md"), blueprint(scoped));
  writeFileSync(join(dir, "rubric.md"), "# 评分标准\n\n| 维度 | 看什么 |\n\n## 评审补充\n\n应用是测试播放器。\n");
  g("add", ".");
  g("commit", "-qm", "init");
  const out = [];
  const built = [];
  const fakeBuild = (sheet, file) => { built.push(sheet.id); writeFileSync(file, "jpg"); };
  const cli = (argv, build = fakeBuild) => { out.length = 0; const code = run(["--dir", dir, ...argv], (l) => out.push(l), build); return { code, text: out.join("\n") }; };
  const mapCli = (...argv) => { const o = []; mapRun(["--dir", dir, ...argv], (l) => o.push(l)); return o.join("\n"); };
  const round = (name, shots, logicalWidth = 360, ignore) => {
    const r = join(repo, "shots", name);
    mkdirSync(r, { recursive: true });
    for (const s of shots) writeFileSync(join(r, `${s.theme}-${s.state}.png`), png(s.w ?? 1080, s.h ?? 2340, s.gray, s.text, { top: s.topClock ?? s.gray, topRows: s.topClock ? 3 : 0 }));
    writeFileSync(join(r, "manifest.json"), JSON.stringify({ platform: "phone-a", logicalWidth, ...(ignore ? { ignore } : {}), shots: shots.map((s) => ({ screen: "a", theme: s.theme, state: s.state, file: `${s.theme}-${s.state}.png` })) }));
    return r;
  };
  return { repo, dir, g, cli, mapCli, round, built };
}

const full = (gray = {}) => [
  { theme: "light", state: "default", gray: gray.ld ?? 10 }, { theme: "dark", state: "default", gray: gray.dd ?? 20 },
  { theme: "light", state: "empty", gray: gray.le ?? 30 }, { theme: "dark", state: "empty", gray: gray.de ?? 40 },
];

test("画面哈希只看像素：忽略附加块和滤波方式，跳过 ignore 区域", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-shots-hash-"));
  writeFileSync(join(dir, "a.png"), png(4, 6, 7, "time 1", { top: 90, topRows: 2 }));
  writeFileSync(join(dir, "b.png"), png(4, 6, 7, "time 2", { top: 90, topRows: 2, filter: 2 }));
  writeFileSync(join(dir, "c.png"), png(4, 6, 7, undefined, { top: 91, topRows: 2 }));
  writeFileSync(join(dir, "d.png"), png(4, 6, 8, undefined, { top: 90, topRows: 2 }));
  const read = (n, ignore) => readImage(join(dir, `${n}.png`), ignore);
  assert.equal(read("a").hash, read("b").hash);
  assert.notEqual(read("a").hash, read("c").hash);
  const statusBar = [{ height: 2 }];
  assert.equal(read("a", statusBar).hash, read("c", statusBar).hash);
  assert.notEqual(read("a", statusBar).hash, read("d", statusBar).hash);
  assert.equal(read("a", [{ x: 0, y: 0, width: 4, height: 2 }]).hash, read("c", statusBar).hash);
  assert.deepEqual([read("a").width, read("a").height], [4, 6]);
});

test("compare 逐格比较两轮，manifest 的 ignore 区域不计", () => {
  const { cli, round } = fixture();
  const shots = (clock) => full().map((s) => ({ ...s, w: 8, h: 16, text: undefined, topClock: clock }));
  const a = round("clock-a", shots(100), 8, [{ height: 3 }]);
  const b = round("clock-b", shots(200), 8, [{ height: 3 }]);
  assert.match(cli(["compare", a, b]).text, /4 格画面一致，0 格不一致/);
  const c = round("clock-c", shots(200), 8);
  const d = round("clock-d", shots(100), 8);
  const r = cli(["compare", c, d]);
  assert.equal(r.code, 1);
  assert.match(r.text, /0 格画面一致，4 格不一致/);
});

test("verify 报出缺截图、多余的 gaps 和没进入状态的截图", () => {
  const { cli, round, dir } = fixture();
  assert.match(cli(["verify", round("ok", full())]).text, /截图清单正常：4 格/);

  const missing = cli(["verify", round("missing", full().slice(0, 3))]);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /a\/dark\/empty：缺截图/);

  const same = cli(["verify", round("same", full({ le: 10 }))]);
  assert.match(same.text, /a\/light：状态 default、empty 的画面完全相同/);

  const screen = JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8"));
  screen.states[1].gaps = { "phone-a": "缺注入入口" };
  writeFileSync(join(dir, "screens/a.json"), JSON.stringify(screen));
  assert.match(cli(["verify", round("gap", full())]).text, /先删掉这个状态在 phone-a 上的 gaps 条目/);
  assert.equal(cli(["verify", round("gap-ok", full().slice(0, 2))]).code, 0);
});

test("拼图按逻辑宽度缩小每格，长边不超过上限，超长截图单独送审", () => {
  const shot = (theme, w, h, logicalWidth) => ({ screen: "a", state: "default", theme, width: w, height: h, logicalWidth, path: `/x/${theme}.png` });
  const phone = layout({ shots: ["dark", "light", "transparent"].map((t) => shot(t, 1080, 2340, 360)) }, ["light", "dark", "transparent"]);
  assert.equal(phone.length, 1);
  assert.deepEqual(phone[0].tiles.map((t) => [t.theme, t.tileWidth, t.tileHeight]), [["light", 360, 780], ["dark", 360, 780], ["transparent", 360, 780]]);

  const desktop = layout({ shots: ["light", "dark"].map((t) => shot(t, 2880, 1800, 1440)) }, ["light", "dark"]);
  assert.deepEqual(desktop.map((s) => s.id), ["a--default--1", "a--default--2"]);
  assert.ok(desktop.every((s) => s.tiles.reduce((n, t) => n + t.tileWidth, 0) <= MAX_EDGE));

  const tall = layout({ shots: [shot("light", 1080, 6000, 360), shot("dark", 1080, 2340, 360)] }, ["light", "dark"]);
  assert.deepEqual(tall.map((s) => [s.id, s.standalone]), [["a--default--light", true], ["a--default", false]]);

  const args = ffmpegArgs(phone[0], "/o.jpg", "C:/Windows/Fonts/arial.ttf");
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /hstack=inputs=3\[out\]/);
  assert.match(filter, new RegExp(`pad=360:${780 + LABEL}:0:${LABEL}`));
  assert.match(filter, /fontfile='C\\:\/Windows\/Fonts\/arial.ttf'/);
});

test("复评只送画面变了的图，沿用的分数经 merge 和 record --from 写回地图", () => {
  const { cli, mapCli, round, dir, built, g } = fixture();
  const r1 = round("r1", full());
  const p1 = cli(["prepare", r1]);
  assert.match(p1.text, /本轮送审 2 张图（4 格），沿用 0 格/);
  assert.deepEqual(built.splice(0), ["a--default", "a--empty"]);

  assert.throws(() => cli(["merge", r1]), /需要 --review/);
  const cellsOf = (state, scores) => ["light", "dark"].map((theme, i) => ({ screen: "a", theme, state,
    dimensions: { 空间比例: scores[i] / 5, 视觉层级: scores[i] / 5, 风格一致性: scores[i] / 5, 可读性: scores[i] / 5, 精致度: scores[i] / 5 },
    deductions: [{ element: "标题", where: "顶部", points: 0.2, kind: "真实问题", suggestion: "标题下移 8pt" }, { element: "按钮", where: "底部", points: 0.5, kind: "个人偏好", suggestion: "按钮对比度提高" }] }));
  const partial = join(r1, "review-partial.json");
  writeFileSync(partial, JSON.stringify({ cells: cellsOf("default", [9.5, 9.2]) }));
  assert.throws(() => cli(["merge", r1, "--review", partial]), /a\/light\/empty：评审结果里没有这一格/);
  const review = join(r1, "review.json");
  writeFileSync(review, JSON.stringify({ cells: [...cellsOf("default", [9.5, 9.2]), ...cellsOf("empty", [8, 9.1])] }));
  const m1 = cli(["merge", r1, "--review", review]);
  assert.match(m1.text, /4 格，1 格低于阈值 9/);
  assert.match(m1.text, /未达标 a\/light\/empty 8：按钮（底部） -0.5［个人偏好］/);

  const r2 = round("r2", full({ le: 31 }));
  const p2 = cli(["prepare", r2, "--prev", r1]);
  assert.match(p2.text, /本轮送审 1 张图（2 格），沿用 2 格/);
  assert.match(p2.text, /a \/ dark \/ default：9.2（上一轮）/);
  assert.deepEqual(built.splice(0), ["a--empty"]);
  const review2 = join(r2, "review.json");
  writeFileSync(review2, JSON.stringify({ cells: cellsOf("empty", [9.3, 9.1]) }));
  cli(["merge", r2, "--review", review2]);
  mapCli("record", "--from", join(r2, "scores.json"));
  const saved = JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8")).scores;
  assert.equal(saved.length, 4);
  assert.equal(saved.find((s) => s.theme === "light" && s.state === "empty").score, 9.3);
  assert.ok(saved.every((s) => /^[0-9a-f]{64}$/.test(s.shot) && s.commit === g("rev-parse", "HEAD").trim()));

  const r3 = round("r3", full({ le: 31 }));
  assert.match(cli(["prepare", r3]).text, /画面都没有变化[\s\S]*9.3（地图 /);
  cli(["merge", r3]);
  assert.match(cli(["prepare", r3, "--fresh"]).text, /本轮送审 2 张图（4 格）/);

  mapCli("invalidate", "a", "--state", "default", "--reason", "蓝图改了顶部布局");
  assert.match(cli(["prepare", round("r4", full({ le: 31 }))]).text, /本轮送审 1 张图（2 格），沿用 2 格/);
});

const dims = (n) => ({ 空间比例: n / 5, 视觉层级: n / 5, 风格一致性: n / 5, 可读性: n / 5, 精致度: n / 5 });
const reviewOf = (cellsList, extra = {}) => ({ cells: cellsList.map(([theme, state, n, suggestion = "标题下移 8pt"]) => ({ screen: "a", theme, state, dimensions: dims(n),
  deductions: [{ element: "标题", where: "顶部", points: 0.3, kind: "真实问题", ...(suggestion ? { suggestion } : {}) }] })), ...extra });
const allCells = (n, suggestion) => ["light", "dark"].flatMap((t) => ["default", "empty"].map((s) => [t, s, n, suggestion]));

test("没有打磨范围的界面走定调轮：提示词要求起草范围，merge 校验草案并给建议编号", () => {
  const { cli, round, dir } = fixture({ scoped: false });
  const r1 = round("r1", full());
  assert.match(cli(["prepare", r1]).text, /定调轮：a 在蓝图里还没有打磨范围/);
  const prompt = readFileSync(join(r1, "prompt.md"), "utf8");
  assert.match(prompt, /定调轮/);
  assert.match(prompt, /为这些界面各起草一份打磨范围：a/);
  assert.match(prompt, /收藏圆点表示同步状态[\s\S]*## 布局：phone[\s\S]*标题在上，列表在下/);
  assert.match(prompt, /应用是测试播放器/);
  assert.match(prompt, /a（甲）：default、empty/);
  assert.doesNotMatch(prompt, /\[\[|决定记录/);
  assert.equal(JSON.parse(readFileSync(join(r1, "plan.json"), "utf8")).mode, "calibrate");

  const noScope = join(r1, "review-no-scope.json");
  writeFileSync(noScope, JSON.stringify(reviewOf(allCells(8))));
  assert.throws(() => cli(["merge", r1, "--review", noScope]), /a：定调轮的评审结果里没有这个界面的打磨范围草案/);
  const noSuggestion = join(r1, "review-no-suggestion.json");
  writeFileSync(noSuggestion, JSON.stringify(reviewOf(allCells(8, null), { scope: [{ screen: "a", locked: [{ item: "区块顺序" }], adjustable: [{ item: "间距" }] }] })));
  assert.throws(() => cli(["merge", r1, "--review", noSuggestion]), /扣分点「标题」没有修改建议/);

  const review = join(r1, "review.json");
  writeFileSync(review, JSON.stringify(reviewOf(allCells(8), {
    scope: [{ screen: "a", locked: [{ item: "区块顺序", why: "现状合理" }], adjustable: [{ item: "标题间距", range: "±50%" }] }],
    directions: [{ screen: "a", text: "考虑合并两个分组" }], blueprintMismatches: [{ sheet: "a--default.jpg", text: "标题不在顶部" }],
  })));
  const m = cli(["merge", r1, "--review", review]);
  assert.match(m.text, /4 条修改建议，1 处与蓝图不一致，1 条方向性建议/);
  assert.match(m.text, /S4 a\/dark\/empty 标题（顶部） -0.3 → 标题下移 8pt/);
  assert.match(m.text, /D1 方向性建议：a 考虑合并两个分组/);
  const sugg = JSON.parse(readFileSync(join(r1, "suggestions.json"), "utf8"));
  assert.deepEqual([sugg.mode, sugg.scope[0].screen, sugg.mismatches[0].id], ["calibrate", "a", "M1"]);

  writeFileSync(join(dir, "blueprints/flow.md"), blueprint(true));
  const r2 = round("r2", full({ le: 31 }));
  assert.match(cli(["prepare", r2, "--prev", r1]).text, /打磨轮：送审界面都有打磨范围/);
  const polish = readFileSync(join(r2, "prompt.md"), "utf8");
  assert.match(polish, /「打磨范围」已经由用户确认[\s\S]*### 打磨范围：a[\s\S]*标题间距，±50% 以内/);
  assert.doesNotMatch(polish, /起草/);
});

test("page 把各轮截图、分数和采纳记录做成网页，图片路径相对网页", () => {
  const { cli, round, repo } = fixture();
  const r1 = round("r1", full());
  cli(["prepare", r1]);
  writeFileSync(join(r1, "review.json"), JSON.stringify(reviewOf(allCells(8))));
  cli(["merge", r1, "--review", join(r1, "review.json")]);
  const r2 = round("r2", full({ le: 31 }));
  cli(["prepare", r2, "--prev", r1]);
  writeFileSync(join(r2, "review.json"), JSON.stringify(reviewOf([["light", "empty", 9.4], ["dark", "empty", 9.1]])));
  cli(["merge", r2, "--review", join(r2, "review.json")]);

  writeFileSync(join(r1, "changes.json"), JSON.stringify({ adopted: [{ id: "S1", change: "标题下移 8pt" }], declined: [{ id: "S2", reason: "改动锁定的区块顺序" }] }));
  const out = join(repo, "shots", "report.html");
  const p = cli(["page", r1, r2, "--out", out]);
  assert.match(p.text, /2 轮，4 格/);
  assert.match(p.text, /r1：changes.json 没有交代 S3、S4/);
  const html = readFileSync(out, "utf8");
  const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(data.rounds.map((r) => r.name), ["r1", "r2"]);
  assert.equal(data.rounds[0].shots[0].src, "r1/light-default.png");
  assert.equal(data.rounds[1].shots.find((s) => s.key === "a/light/empty").score, 9.4);
  assert.equal(data.rounds[0].adopted[0].change, "标题下移 8pt");
  assert.equal(data.cells[0].label, "甲 / light / default");
});

test("record --from 有一格不合法时整批都不写", () => {
  const { dir, mapCli, repo } = fixture();
  const file = join(repo, "scores.json");
  writeFileSync(file, JSON.stringify([
    { screen: "a", platform: "phone-a", theme: "light", state: "default", score: 9.4, deductions: [] },
    { screen: "a", platform: "phone-a", theme: "light", state: "nope", score: 9.4, deductions: [] },
  ]));
  assert.throws(() => mapCli("record", "--from", file), /没有状态 nope/);
  assert.equal(JSON.parse(readFileSync(join(dir, "screens/a.json"), "utf8")).scores.length, 0);
});

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("ffmpeg 真实拼出一张带标签的 JPEG", { skip: !hasFfmpeg && "本机没有 ffmpeg" }, () => {
  const { cli, round } = fixture({ themes: ["light", "dark"], states: [{ id: "default" }] });
  const r = round("real", [{ theme: "light", state: "default", gray: 200 }, { theme: "dark", state: "default", gray: 30 }]);
  assert.equal(cli(["prepare", r], defaultBuild()).code, 0);
  const sheet = readImage(join(r, "sheets", "a--default.jpg"));
  assert.deepEqual([sheet.width, sheet.height], [720, 780 + LABEL]);
});
