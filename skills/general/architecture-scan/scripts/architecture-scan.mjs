#!/usr/bin/env node
// architecture-scan 机械辅助：运行目录与锁、解析最后一个 JSON、校验 schema、
// 写 manifest、安全清理。不发起仓库扫描，不调用 issue API，不读取凭证。
//
// 用法：
//   node architecture-scan.mjs init-run [--work-dir DIR]
//   node architecture-scan.mjs acquire-lock --work-dir DIR [--name .summary.lock]
//   node architecture-scan.mjs parse-out <out.txt>
//   node architecture-scan.mjs validate-findings <findings.json>
//   node architecture-scan.mjs write-manifest --work-dir DIR
//   node architecture-scan.mjs cleanup --work-dir DIR
//
// 退出码：0 成功；2 用法错误；3 锁已存在或清理被拒绝；4 解析/校验失败。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const RUN_KIND = "architecture-scan-run";
export const RUN_MARKER = "run.json";
export const RUN_LOCK = ".run.lock";
export const SUMMARY_LOCK = ".summary.lock";
export const WORK_DIR_NAME = /^architecture-scan-\d{8}-\d{4}(?:-\d+)?$/;

export const SEVERITIES = new Set(["P0", "P1", "P2", "Note"]);
export const STRENGTHS = new Set(["Strong", "Worth exploring", "Speculative"]);
export const STATUSES = new Set(["ok", "timeout", "failed", "clone_failed", "missing"]);

export class UsageError extends Error {}
export class LockError extends Error {}
export class ParseError extends Error {}
export class CleanupError extends Error {}

const USAGE = `用法：node architecture-scan.mjs <命令> [参数]

  init-run [--work-dir DIR]
      创建运行目录、写入 run.json，并原子占有 .run.lock
  acquire-lock --work-dir DIR [--name .summary.lock]
      在运行目录内 mkdir 原子锁；已存在则退出码 3
  parse-out <out.txt>
      从文件取出最后一个完整 JSON，打印到标准输出
  validate-findings <findings.json>
      校验架构扫描 schema 后打印该对象
  write-manifest --work-dir DIR
      根据 *.status 写 manifest.json
  cleanup --work-dir DIR
      仅删除带本技能标记且路径吻合的运行目录

不扫描仓库，不访问 issue 服务，不读取 API key。`;

export function stamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}`;
}

export function defaultWorkDir(now = new Date(), pid = process.pid) {
  const base = join(tmpdir(), `architecture-scan-${stamp(now)}`);
  return existsSync(base) ? `${base}-${pid}` : base;
}

/** 从 start 扫描一个完整 JSON 值，成功返回结束下标（不含后续），失败返回 -1。 */
export function scanJsonValue(text, start) {
  const skipWs = (i) => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    return i;
  };
  const scanString = (i) => {
    i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === "\"") return i + 1;
      i++;
    }
    return -1;
  };
  const scanNumber = (i) => {
    const begin = i;
    if (text[i] === "-") i++;
    if (i >= text.length) return -1;
    if (text[i] === "0") i++;
    else if (text[i] >= "1" && text[i] <= "9") {
      while (i < text.length && text[i] >= "0" && text[i] <= "9") i++;
    } else return -1;
    if (text[i] === ".") {
      i++;
      if (!(text[i] >= "0" && text[i] <= "9")) return -1;
      while (i < text.length && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!(text[i] >= "0" && text[i] <= "9")) return -1;
      while (i < text.length && text[i] >= "0" && text[i] <= "9") i++;
    }
    return i > begin ? i : -1;
  };
  const scanLiteral = (i, word) => (text.startsWith(word, i) ? i + word.length : -1);
  const scanArray = (i) => {
    i++;
    i = skipWs(i);
    if (text[i] === "]") return i + 1;
    while (i < text.length) {
      i = scanValue(i);
      if (i < 0) return -1;
      i = skipWs(i);
      if (text[i] === "]") return i + 1;
      if (text[i] !== ",") return -1;
      i = skipWs(i + 1);
    }
    return -1;
  };
  const scanObject = (i) => {
    i++;
    i = skipWs(i);
    if (text[i] === "}") return i + 1;
    while (i < text.length) {
      if (text[i] !== "\"") return -1;
      i = scanString(i);
      if (i < 0) return -1;
      i = skipWs(i);
      if (text[i] !== ":") return -1;
      i = scanValue(skipWs(i + 1));
      if (i < 0) return -1;
      i = skipWs(i);
      if (text[i] === "}") return i + 1;
      if (text[i] !== ",") return -1;
      i = skipWs(i + 1);
    }
    return -1;
  };
  const scanValue = (i) => {
    i = skipWs(i);
    if (i >= text.length) return -1;
    const ch = text[i];
    if (ch === "\"") return scanString(i);
    if (ch === "{") return scanObject(i);
    if (ch === "[") return scanArray(i);
    if (ch === "t") return scanLiteral(i, "true");
    if (ch === "f") return scanLiteral(i, "false");
    if (ch === "n") return scanLiteral(i, "null");
    if (ch === "-" || (ch >= "0" && ch <= "9")) return scanNumber(i);
    return -1;
  };
  if (start < 0 || start >= text.length) return -1;
  const ch = text[start];
  if (ch !== "{" && ch !== "[") return -1;
  return scanValue(start);
}

/** 从文本中取出最后一个完整的顶层 JSON 值（对象或数组）。 */
export function extractLastJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new ParseError("输出为空，没有 JSON");
  }
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = scanJsonValue(text, i);
    if (end <= i) continue;
    const raw = text.slice(i, end);
    try {
      found.push({ start: i, end, raw, value: JSON.parse(raw) });
    } catch {
      // 扫描器与 JSON.parse 不一致时跳过
    }
  }
  const top = found.filter(
    (a) => !found.some((b) => (b.start < a.start && b.end >= a.end) || (b.start <= a.start && b.end > a.end)),
  );
  const last = top.at(-1);
  if (!last) throw new ParseError("没有找到完整且可解析的 JSON");
  return { value: last.value, raw: last.raw };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function failSchema(msg) {
  throw new ParseError(msg);
}

export function validateFindings(value) {
  if (!isPlainObject(value)) failSchema("根节点必须是对象");
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    failSchema("summary 必须是非空字符串");
  }
  if (!Array.isArray(value.findings)) failSchema("findings 必须是数组");
  value.findings.forEach((item, i) => {
    const p = `findings[${i}]`;
    if (!isPlainObject(item)) failSchema(`${p} 必须是对象`);
    if (!SEVERITIES.has(item.severity)) failSchema(`${p}.severity 非法`);
    if (typeof item.file !== "string") failSchema(`${p}.file 必须是字符串`);
    if (!(item.line === null || (Number.isInteger(item.line) && item.line >= 0))) {
      failSchema(`${p}.line 必须是非负整数或 null`);
    }
    for (const k of ["title", "body", "suggestion"]) {
      if (typeof item[k] !== "string" || !item[k].trim()) failSchema(`${p}.${k} 必须是非空字符串`);
    }
    const c = item.candidate;
    if (!isPlainObject(c)) failSchema(`${p} 缺少 candidate 对象`);
    if (typeof c.name !== "string" || !c.name.trim()) failSchema(`${p}.candidate.name 必须是非空字符串`);
    if (!Array.isArray(c.files) || c.files.some((f) => typeof f !== "string")) {
      failSchema(`${p}.candidate.files 必须是字符串数组`);
    }
    for (const k of ["problem", "solution"]) {
      if (typeof c[k] !== "string" || !c[k].trim()) failSchema(`${p}.candidate.${k} 必须是非空字符串`);
    }
    if (!STRENGTHS.has(c.strength)) failSchema(`${p}.candidate.strength 非法`);
    if (!Array.isArray(c.wins) || c.wins.some((w) => typeof w !== "string")) {
      failSchema(`${p}.candidate.wins 必须是字符串数组`);
    }
  });
  return value;
}

export function acquireLock(dir, name = RUN_LOCK) {
  if (!name || name.includes(sep) || name === "." || name === "..") {
    throw new UsageError(`非法锁名：${name}`);
  }
  const parent = resolve(dir);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new UsageError(`目录不存在：${parent}`);
  }
  const lock = join(parent, name);
  try {
    mkdirSync(lock);
    return lock;
  } catch (err) {
    if (err && err.code === "EEXIST") throw new LockError(`锁已存在：${lock}`);
    throw err;
  }
}

export function readRunMarker(dir) {
  const marker = join(resolve(dir), RUN_MARKER);
  if (!existsSync(marker)) return null;
  try {
    return JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    return null;
  }
}

export function initRun(workDir, now = new Date()) {
  const dir = resolve(workDir);
  if (!WORK_DIR_NAME.test(basename(dir))) {
    throw new UsageError(
      `工作目录名必须匹配 architecture-scan-YYYYMMDD-HHMM：${basename(dir)}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  if (!WORK_DIR_NAME.test(basename(real))) {
    throw new UsageError(`解析后的工作目录名不合法：${real}`);
  }
  acquireLock(real, RUN_LOCK);
  const marker = {
    kind: RUN_KIND,
    created_at: now.toISOString(),
    work_dir: real,
  };
  writeFileSync(join(real, RUN_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return { dir: real, marker };
}

function isForbiddenRoot(real) {
  const homes = new Set(
    [tmpdir(), homedir(), resolve("/"), resolve("/tmp"), resolve("/var/tmp")]
      .filter(Boolean)
      .map((p) => realpathSync(p)),
  );
  return homes.has(real);
}

export function assertSafeCleanup(dir) {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new CleanupError(`目录不存在：${abs}`);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    throw new CleanupError(`无法解析路径：${abs}`);
  }
  if (isForbiddenRoot(real)) throw new CleanupError(`拒绝删除受保护目录：${real}`);
  if (!WORK_DIR_NAME.test(basename(real))) {
    throw new CleanupError(`拒绝删除：目录名不是本技能的运行目录`);
  }
  const marker = readRunMarker(real);
  if (!marker || marker.kind !== RUN_KIND || typeof marker.work_dir !== "string") {
    throw new CleanupError(`拒绝删除：缺少有效的 ${RUN_MARKER}`);
  }
  let recorded;
  try {
    recorded = realpathSync(marker.work_dir);
  } catch {
    throw new CleanupError(`拒绝删除：run.json 中的路径无法解析`);
  }
  if (recorded !== real) {
    throw new CleanupError(`拒绝删除：路径与 run.json 记录不一致`);
  }
  return real;
}

export function cleanup(dir) {
  const real = assertSafeCleanup(dir);
  rmSync(real, { recursive: true, force: false });
  return real;
}

export function parseStatusLine(text) {
  const line = String(text ?? "").trim().split(/\n/, 1)[0].trim();
  const parts = line.split(/\s+/);
  const status = parts[0] || "missing";
  const exitRaw = parts[1];
  const sha = parts.slice(2).join(" ") || "";
  let exit_code = null;
  if (exitRaw !== undefined && exitRaw !== "") {
    const n = Number(exitRaw);
    exit_code = Number.isFinite(n) ? n : null;
  }
  return { status: STATUSES.has(status) ? status : "missing", exit_code, sha };
}

export function buildManifest(workDir, extras = {}) {
  const dir = resolve(workDir);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const shorts = [
    ...new Set(
      files
        .filter((f) => f.endsWith(".status") && !f.startsWith("."))
        .map((f) => f.slice(0, -".status".length)),
    ),
  ].sort();
  const repos = shorts.map((short) => {
    const raw = readFileSync(join(dir, `${short}.status`), "utf8");
    const { status, exit_code, sha } = parseStatusLine(raw);
    return {
      short,
      status,
      exit_code,
      sha,
      out: files.includes(`${short}.out.txt`) ? `${short}.out.txt` : null,
    };
  });
  return {
    task: extras.task ?? "架构扫描",
    dir,
    finished: extras.finished ?? new Date().toISOString(),
    repos,
  };
}

export function writeManifest(workDir, extras = {}) {
  const manifest = buildManifest(workDir, extras);
  const dest = join(resolve(workDir), "manifest.json");
  writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dest, manifest };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {}, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.flags.add("help");
    else if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      out.opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out.flags.add(a.slice(2));
    } else out.pos.push(a);
  }
  return out;
}

export function run(argv, io = { log: console.log, err: console.error }) {
  const args = parseArgs(argv);
  if (args.flags.has("help") || args.pos[0] === "help" || args.pos.length === 0) {
    io.log(USAGE);
    return args.pos.length === 0 && !args.flags.has("help") ? 2 : 0;
  }
  const cmd = args.pos[0];
  const rest = args.pos.slice(1);
  try {
    if (cmd === "init-run") {
      const dir = args.opts["work-dir"] ?? defaultWorkDir();
      const { dir: real } = initRun(dir);
      io.log(real);
      return 0;
    }
    if (cmd === "acquire-lock") {
      const dir = args.opts["work-dir"];
      if (!dir) throw new UsageError("需要 --work-dir");
      const name = args.opts.name ?? SUMMARY_LOCK;
      const lock = acquireLock(dir, name);
      io.log(lock);
      return 0;
    }
    if (cmd === "parse-out") {
      const file = rest[0];
      if (!file) throw new UsageError("需要 out.txt 路径");
      const { value } = extractLastJson(readFileSync(file, "utf8"));
      io.log(JSON.stringify(value, null, 2));
      return 0;
    }
    if (cmd === "validate-findings") {
      const file = rest[0];
      if (!file) throw new UsageError("需要 findings.json 路径");
      const value = validateFindings(readJsonFile(file));
      io.log(JSON.stringify(value, null, 2));
      return 0;
    }
    if (cmd === "write-manifest") {
      const dir = args.opts["work-dir"];
      if (!dir) throw new UsageError("需要 --work-dir");
      const { dest } = writeManifest(dir);
      io.log(dest);
      return 0;
    }
    if (cmd === "cleanup") {
      const dir = args.opts["work-dir"];
      if (!dir) throw new UsageError("需要 --work-dir");
      io.log(cleanup(dir));
      return 0;
    }
    throw new UsageError(`未知命令：${cmd}`);
  } catch (err) {
    io.err(err.message ?? String(err));
    if (err instanceof UsageError) return 2;
    if (err instanceof LockError || err instanceof CleanupError) return 3;
    if (err instanceof ParseError) return 4;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exitCode = 1;
  }
}
