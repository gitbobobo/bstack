#!/usr/bin/env node
// 截图轮次：校验一轮截图的清单，按主题拼图送审，沿用画面没变的格子的分数，合并评审结果。
//
// 用法：node ui-shots.mjs <命令> [选项]，--help 查看全部命令。
// 地图目录默认是本脚本所在技能目录（scripts/ 的上一级），可用 --dir 覆盖。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { cells, loadMap, parseArgs, platformsOf, validate } from "./ui-map.mjs";

const USAGE = `用法：node ui-shots.mjs <命令> [选项]

命令：
  hash <图片>...                  打印画面哈希；同一格连拍两次哈希相同，截图才算稳定
  verify <轮次目录>               校验 manifest.json：每个出现的界面在本平台上的格子是否截全、
                                  文件能否读取、不同状态是否截成了同一张图
  prepare <轮次目录> [--prev <上一轮目录>] [--fresh]
                                  先做 verify，再按「界面 × 状态」拼图（同一张图里放各主题），
                                  画面没变的格子沿用上一轮或地图里的分数，写 plan.json 并列出送审图片
  merge <轮次目录> [--review <评审结果.json>]
                                  把评审结果和沿用的分数合成 scores.json，供 ui-map record --from 使用

通用选项：
  --dir <技能目录>                默认是本脚本的上一级目录`;

// 多数模型把长边超过约 1568px 的图片先缩小再读，拼图的长边不超过它，每格的像素才不会被二次压缩。
export const MAX_EDGE = 1568;
export const LABEL = 32;
const FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
];

// 画面哈希：PNG 只取尺寸和解压后的像素数据，忽略时间戳等附加块；其他格式取文件字节。
export function readImage(file) {
  const buf = readFileSync(file);
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    let ihdr = null;
    const idat = [];
    for (let i = 8; i + 8 <= buf.length;) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString("ascii", i + 4, i + 8);
      const data = buf.subarray(i + 8, i + 8 + len);
      if (type === "IHDR") ihdr = data;
      if (type === "IDAT") idat.push(data);
      i += 12 + len;
    }
    if (!ihdr || !idat.length) throw new Error(`${file} 不是完整的 PNG`);
    const hash = createHash("sha256").update(ihdr).update(inflateSync(Buffer.concat(idat))).digest("hex");
    return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), hash };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), hash: createHash("sha256").update(buf).digest("hex") };
      }
      i += 2 + len;
    }
    throw new Error(`${file} 是 JPEG，但读不到尺寸`);
  }
  throw new Error(`${file} 不是 PNG 或 JPEG`);
}

export function loadRound(dir) {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) throw new Error(`找不到 ${file}，截图工具要在轮次目录里写 manifest.json`);
  const m = JSON.parse(readFileSync(file, "utf8"));
  if (!m.platform || !Array.isArray(m.shots) || !m.shots.length) throw new Error(`${file} 需要 platform 和非空的 shots`);
  const shots = m.shots.map((s) => {
    if (!s.screen || !s.theme || !s.state || !s.file) throw new Error(`${file}：每条 shot 需要 screen、theme、state、file`);
    const path = isAbsolute(s.file) ? s.file : resolve(dir, s.file);
    if (!existsSync(path)) throw new Error(`${file}：找不到图片 ${path}`);
    return { ...s, path, logicalWidth: s.logicalWidth ?? m.logicalWidth, ...readImage(path) };
  });
  return { dir: resolve(dir), platform: m.platform, shots };
}

const key = (c) => `${c.screen}/${c.theme}/${c.state}`;

export function verifyRound(map, round) {
  const errors = validate(map);
  const { config } = map;
  const { platform, shots } = round;
  if (!config.platforms.includes(platform)) errors.push(`manifest 的平台 ${platform} 不在 config.platforms 中`);
  const seen = new Map();
  for (const s of shots) {
    const screen = map.screens.find((x) => x.id === s.screen);
    if (!screen) { errors.push(`${key(s)}：地图里没有界面 ${s.screen}`); continue; }
    if (!platformsOf(screen, config).includes(platform)) errors.push(`${key(s)}：${s.screen} 不支持平台 ${platform}`);
    if (!(screen.themes ?? config.themes).includes(s.theme)) errors.push(`${key(s)}：${s.screen} 没有主题 ${s.theme}`);
    const state = screen.states.find((x) => x.id === s.state);
    if (!state) errors.push(`${key(s)}：${s.screen} 没有状态 ${s.state}`);
    else if (state.gaps?.[platform]) errors.push(`${key(s)}：已经截到了，先删掉这个状态在 ${platform} 上的 gaps 条目`);
    if (seen.has(key(s))) errors.push(`${key(s)}：manifest 里出现了两次`);
    seen.set(key(s), s);
  }
  for (const id of new Set(shots.map((s) => s.screen))) {
    const screen = map.screens.find((x) => x.id === id);
    if (!screen) continue;
    for (const c of cells(screen, config, () => [], [platform])) {
      if (c.status !== "gap" && !seen.has(key({ screen: id, ...c }))) errors.push(`${id}/${c.theme}/${c.state}：缺截图`);
    }
  }
  const byHash = new Map();
  for (const s of shots) {
    const k = `${s.screen}/${s.theme}/${s.hash}`;
    byHash.set(k, [...(byHash.get(k) ?? []), s.state]);
  }
  for (const [k, states] of byHash) {
    if (states.length > 1) errors.push(`${k.split("/").slice(0, 2).join("/")}：状态 ${states.join("、")} 的画面完全相同，截图前没有进入对应状态`);
  }
  return errors;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// 一张拼图 = 一个界面的一个状态，各主题从左到右排开；每格不小于逻辑宽度，拼图长边不超过 MAX_EDGE。
export function layout(round, themes) {
  const groups = new Map();
  for (const s of round.shots) {
    const k = `${s.screen}--${s.state}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const sheets = [];
  for (const [id, shots] of groups) {
    const tiles = shots
      .sort((a, b) => themes.indexOf(a.theme) - themes.indexOf(b.theme))
      .map((s) => {
        const tileWidth = even(Math.min(s.width, s.logicalWidth ?? s.width));
        return { ...s, label: `${s.screen} / ${s.theme} / ${s.state}`, tileWidth, tileHeight: even((s.height * tileWidth) / s.width) };
      });
    const tall = tiles.filter((t) => t.tileHeight + LABEL > MAX_EDGE || t.tileWidth > MAX_EDGE);
    for (const t of tall) sheets.push({ id: `${id}--${t.theme}`, standalone: true, tiles: [t] });
    const rest = tiles.filter((t) => !tall.includes(t));
    if (!rest.length) continue;
    const perSheet = Math.max(1, Math.floor(MAX_EDGE / Math.max(...rest.map((t) => t.tileWidth))));
    const chunks = [];
    for (let i = 0; i < rest.length; i += perSheet) chunks.push(rest.slice(i, i + perSheet));
    chunks.forEach((c, i) => sheets.push({ id: chunks.length > 1 ? `${id}--${i + 1}` : id, standalone: false, tiles: c }));
  }
  return sheets;
}

// 画面哈希相同就沿用分数：先找上一轮，再找地图；被 invalidate 标记的分数不沿用，--fresh 时一律重评。
export function attachCarry(sheets, { platform, map, prev, fresh }) {
  for (const sheet of sheets) {
    for (const t of sheet.tiles) {
      if (fresh) continue;
      const fromPrev = prev?.find((p) => p.platform === platform && key(p) === key(t) && p.shot === t.hash);
      if (fromPrev) { t.carry = { score: fromPrev.score, deductions: fromPrev.deductions ?? [], from: "上一轮" }; continue; }
      const screen = map.screens.find((s) => s.id === t.screen);
      const recorded = screen?.scores?.find((x) => x.platform === platform && x.theme === t.theme && x.state === t.state);
      if (recorded?.shot === t.hash && !recorded.invalidated) {
        t.carry = { score: recorded.score, deductions: recorded.deductions ?? [], from: `地图 ${recorded.commit.slice(0, 8)}` };
      }
    }
    sheet.review = sheet.tiles.some((t) => !t.carry);
  }
  return sheets;
}

const escFilter = (v) => `'${String(v).replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:")}'`;

export function ffmpegArgs(sheet, out, font) {
  const height = Math.max(...sheet.tiles.map((t) => t.tileHeight)) + LABEL;
  const parts = sheet.tiles.map((t, i) => [
    `[${i}:v]scale=${t.tileWidth}:${t.tileHeight}`,
    `pad=${t.tileWidth}:${height}:0:${LABEL}:color=0x202020`,
    `drawtext=${font ? `fontfile=${escFilter(font)}:` : ""}expansion=none:text=${escFilter(t.label)}:x=8:y=8:fontsize=18:fontcolor=white[t${i}]`,
  ].join(","));
  const n = sheet.tiles.length;
  const filter = n > 1 ? `${parts.join(";")};${sheet.tiles.map((_, i) => `[t${i}]`).join("")}hstack=inputs=${n}[out]` : parts[0];
  return ["-hide_banner", "-loglevel", "error", "-y", ...sheet.tiles.flatMap((t) => ["-i", t.path]),
    "-filter_complex", filter, "-map", n > 1 ? "[out]" : "[t0]", "-frames:v", "1", "-update", "1", "-q:v", "3", out];
}

export function magickArgs(sheet, out) {
  const height = Math.max(...sheet.tiles.map((t) => t.tileHeight)) + LABEL;
  return [...sheet.tiles.flatMap((t) => ["(", t.path, "-resize", `${t.tileWidth}x${t.tileHeight}!`, "-background", "#202020",
    "-gravity", "North", "-splice", `0x${LABEL}`, "-fill", "white", "-pointsize", "18", "-annotate", "+0+7", t.label,
    "-extent", `${t.tileWidth}x${height}`, ")"]), "-background", "#202020", "+append", "-quality", "85", out];
}

const has = (cmd) => { try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } };

export function defaultBuild() {
  let tool;
  return (sheet, out) => {
    tool ??= has("magick") ? "magick" : has("ffmpeg") ? "ffmpeg" : null;
    if (!tool) throw new Error("拼图需要 ImageMagick（magick）或 ffmpeg，先在本机装好其中一个");
    if (tool === "magick") execFileSync("magick", magickArgs(sheet, out), { stdio: ["ignore", "ignore", "pipe"] });
    else {
      const font = process.env.UI_SHOTS_FONT ?? FONTS.find((f) => existsSync(f));
      execFileSync("ffmpeg", ffmpegArgs(sheet, out, font), { stdio: ["ignore", "ignore", "pipe"] });
    }
  };
}

const readJson = (file, hint) => {
  if (!existsSync(file)) throw new Error(`找不到 ${file}${hint ? `，${hint}` : ""}`);
  return JSON.parse(readFileSync(file, "utf8"));
};

function formatDeduction(d) {
  if (typeof d === "string") return d;
  const where = d.where ? `（${d.where}）` : "";
  const pref = d.kind && d.kind !== "真实问题" ? `［${d.kind}］` : "";
  return `${d.element ?? ""}${where} -${d.points}${pref}`;
}

export function mergeReview(plan, review) {
  const errors = [];
  const out = [];
  const notes = [];
  for (const sheet of plan.sheets) {
    for (const t of sheet.tiles) {
      const base = { screen: t.screen, platform: plan.platform, theme: t.theme, state: t.state, shot: t.hash };
      if (!sheet.review) { out.push({ ...base, score: t.carry.score, deductions: t.carry.deductions }); continue; }
      const cell = review?.cells?.find((c) => key(c) === key(t));
      if (!cell) { errors.push(`${key(t)}：评审结果里没有这一格（图片 ${sheet.id}）`); continue; }
      const dims = Object.values(cell.dimensions ?? {});
      const sum = dims.length ? Math.round(dims.reduce((a, b) => a + b, 0) * 10) / 10 : null;
      const score = sum ?? cell.total;
      if (typeof score !== "number") { errors.push(`${key(t)}：没有分数`); continue; }
      if (sum !== null && typeof cell.total === "number" && Math.abs(sum - cell.total) > 0.05) notes.push(`${key(t)}：评审员的总分 ${cell.total} 与各维度之和 ${sum} 不一致，按维度之和记录`);
      const deductions = [...(cell.deductions ?? [])].sort((a, b) => (b.points ?? 0) - (a.points ?? 0)).slice(0, 5).map(formatDeduction);
      out.push({ ...base, score, deductions });
    }
  }
  return { errors, scores: out, notes };
}

export function run(argv, log = console.log, build = defaultBuild()) {
  const args = parseArgs(argv, ["help", "fresh"]);
  const [cmd, ...rest] = args._;
  if (!cmd || args.help) { log(USAGE); return 0; }

  if (cmd === "hash") {
    if (!rest.length) throw new Error("hash 需要图片路径");
    for (const f of rest) log(`${readImage(f).hash}  ${f}`);
    return 0;
  }

  const dir = resolve(args.dir ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const map = loadMap(dir);
  const [roundDir] = rest;
  if (!roundDir) throw new Error(`${cmd} 需要轮次目录`);

  if (cmd === "verify" || cmd === "prepare") {
    const round = loadRound(roundDir);
    const errors = verifyRound(map, round);
    if (cmd === "verify" || errors.length) {
      for (const e of errors) log(`错误：${e}`);
      if (!errors.length) log(`截图清单正常：${round.shots.length} 格，平台 ${round.platform}。`);
      return errors.length ? 1 : 0;
    }
    const prev = args.prev ? readJson(join(resolve(args.prev), "scores.json"), "先对上一轮运行 merge") : null;
    const sheets = attachCarry(layout(round, map.config.themes), { platform: round.platform, map, prev, fresh: args.fresh });
    mkdirSync(join(round.dir, "sheets"), { recursive: true });
    for (const s of sheets) {
      s.file = s.standalone ? s.tiles[0].path : join(round.dir, "sheets", `${s.id}.jpg`);
      if (s.review && !s.standalone) build(s, s.file);
    }
    const plan = {
      platform: round.platform, createdAt: new Date().toISOString(),
      sheets: sheets.map((s) => ({ id: s.id, file: s.file, review: s.review,
        tiles: s.tiles.map((t) => ({ screen: t.screen, theme: t.theme, state: t.state, label: t.label, path: t.path, hash: t.hash, ...(t.carry ? { carry: t.carry } : {}) })) })),
    };
    writeFileSync(join(round.dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    const review = plan.sheets.filter((s) => s.review);
    const carried = plan.sheets.filter((s) => !s.review).flatMap((s) => s.tiles);
    log(`本轮送审 ${review.length} 张图（${review.reduce((n, s) => n + s.tiles.length, 0)} 格），沿用 ${carried.length} 格的分数。`);
    if (review.length) {
      log("\n送审图片：");
      for (const s of review) log(`${s.file}  ${s.tiles.map((t) => t.label).join(" | ")}`);
      log("\n原图（拼图上看不清细节时才打开）：");
      for (const t of review.flatMap((s) => s.tiles)) log(`${t.path}  ${t.label}`);
    } else log("画面都没有变化，不需要评审，直接运行 merge。");
    if (carried.length) {
      log("\n沿用的分数：");
      for (const t of carried) log(`- ${t.label}：${t.carry.score}（${t.carry.from}）`);
    }
    return 0;
  }

  if (cmd === "merge") {
    const round = resolve(roundDir);
    const plan = readJson(join(round, "plan.json"), "先运行 prepare");
    const needsReview = plan.sheets.some((s) => s.review);
    if (needsReview && !args.review) throw new Error("本轮有送审图片，merge 需要 --review <评审结果.json>");
    const review = args.review ? readJson(resolve(args.review)) : null;
    const { errors, scores, notes } = mergeReview(plan, review);
    if (errors.length) throw new Error(`评审结果不完整，让评审员补齐后再合并：\n${errors.join("\n")}`);
    writeFileSync(join(round, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`);
    for (const n of notes) log(`提示：${n}`);
    const low = scores.filter((s) => s.score < map.config.threshold);
    log(`已写入 ${join(round, "scores.json")}：${scores.length} 格，${low.length} 格低于阈值 ${map.config.threshold}。`);
    for (const id of new Set(scores.map((s) => s.screen))) {
      log(`- ${id}：最低分 ${Math.min(...scores.filter((s) => s.screen === id).map((s) => s.score))}`);
    }
    for (const s of low) log(`  未达标 ${key(s)} ${s.score}：${s.deductions[0] ?? "（无扣分点）"}`);
    for (const m of review?.blueprintMismatches ?? []) log(`与蓝图不一致：${typeof m === "string" ? m : `${m.sheet ?? ""} ${m.text ?? JSON.stringify(m)}`}`);
    return 0;
  }

  throw new Error(`未知命令 ${cmd}\n\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
