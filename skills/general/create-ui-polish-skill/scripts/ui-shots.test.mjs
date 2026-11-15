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

function png(width, height, gray, text) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, gray);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), ...(text ? [chunk("tEXt", Buffer.from(text))] : []),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fixture({ themes = ["light", "dark"], states = [{ id: "default" }, { id: "empty" }] } = {}) {
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
  writeFileSync(join(dir, "screens/a.json"), JSON.stringify({ id: "a", name: "甲", sources: { "phone-a": ["app/a.kt"] }, states, scores: [] }));
  g("add", ".");
  g("commit", "-qm", "init");
  const out = [];
  const built = [];
  const fakeBuild = (sheet, file) => { built.push(sheet.id); writeFileSync(file, "jpg"); };
  const cli = (argv, build = fakeBuild) => { out.length = 0; const code = run(["--dir", dir, ...argv], (l) => out.push(l), build); return { code, text: out.join("\n") }; };
  const mapCli = (...argv) => { const o = []; mapRun(["--dir", dir, ...argv], (l) => o.push(l)); return o.join("\n"); };
  const round = (name, shots, logicalWidth = 360) => {
    const r = join(repo, "shots", name);
    mkdirSync(r, { recursive: true });
    for (const s of shots) writeFileSync(join(r, `${s.theme}-${s.state}.png`), png(s.w ?? 1080, s.h ?? 2340, s.gray, s.text));
    writeFileSync(join(r, "manifest.json"), JSON.stringify({ platform: "phone-a", logicalWidth, shots: shots.map((s) => ({ screen: "a", theme: s.theme, state: s.state, file: `${s.theme}-${s.state}.png` })) }));
    return r;
  };
  return { repo, dir, g, cli, mapCli, round, built };
}

const full = (gray = {}) => [
  { theme: "light", state: "default", gray: gray.ld ?? 10 }, { theme: "dark", state: "default", gray: gray.dd ?? 20 },
  { theme: "light", state: "empty", gray: gray.le ?? 30 }, { theme: "dark", state: "empty", gray: gray.de ?? 40 },
];

test("画面哈希只看像素，忽略 PNG 的附加块", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-shots-hash-"));
  writeFileSync(join(dir, "a.png"), png(4, 4, 7, "time 1"));
  writeFileSync(join(dir, "b.png"), png(4, 4, 7, "time 2"));
  writeFileSync(join(dir, "c.png"), png(4, 4, 8));
  const [a, b, c] = ["a", "b", "c"].map((n) => readImage(join(dir, `${n}.png`)));
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.deepEqual([a.width, a.height], [4, 4]);
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
    deductions: [{ element: "标题", where: "顶部", points: 0.2, kind: "真实问题" }, { element: "按钮", where: "底部", points: 0.5, kind: "个人偏好" }] }));
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
