#!/usr/bin/env node
// t3-worktree-gc.mjs — 回收 ~/.t3/worktrees/ 下「其他已终结线程」留下的孤儿工作树。
//
// 背景：T3 线程把工作区绑定到工作树后没有解绑接口；绑定中的目录被删会让该线程
// 的终端永久失效（spawn 在命令运行前失败，cd 救不回来）。所以本脚本只回收
// 「没有任何存活线程绑定」的工作树；调用者自己所在的工作树同样永不删除——
// 自己工作树的回收交给后续会话收尾时跑本脚本。
//
// 用法：
//   node t3-worktree-gc.mjs              # dry-run：逐目录打印结论，不删任何东西
//   node t3-worktree-gc.mjs --apply      # 真正执行回收
//   node t3-worktree-gc.mjs --root <dir> # 单独指定扫描根
//   node t3-worktree-gc.mjs --purge-build [--apply]
//                                        # 对因脏树/未推送等 git 原因保留的工作树，
//                                        # 只删可重建的构建产物目录（见 purgeTargets）
//   --measure-size                       # 显式运行 du 统计候选产物大小（可能慢）
//   --diagnose                           # 对已阻断的树也收集 git 原因
//
// 环境变量 T3CODE_HOME 覆盖 ~/.t3（worktrees=<home>/worktrees、
// 数据库=<home>/userdata/statev2.sqlite），主要给测试夹具用。
//
// 目录布局容忍两种：<root>/<工作树> 或 <root>/<分组名>/<工作树名>（分组名是
// 原仓库目录名，如 ~/.t3/worktrees/musiver/t3code-abc123）。
//
// 回收条件——全部满足才删，任一不满足则 skip 并注明原因：
//   a. 不是调用者自己所在的工作树（process.cwd() 的 realpath 不在其内）；
//   b. 是 git 链接工作树（rev-parse 成功且 --git-dir 与 --git-common-dir 解析后
//      不同；相同是独立 clone。非 git 目录/gitfile 失效标 not-a-worktree 只报告）；
//   c. DB 里 worktreePath 等于该路径的线程全部已终结（settledOverride='settled'、
//      archived 或 deleted 任一；委派子线程的 settledOverride 永不写入，
//      改看 subagents 表关联行是否全部终态）。有未终结线程则区分主线程/
//      委派线程报告。零绑定允许回收，报告标 unbound；
//   d. 未终结的绑定线程没有 queued/preparing/starting/running/waiting 状态
//      的 run；已终结线程上的活跃 run 是 runs 投影滞留（子线程完工后状态
//      偶发停更），按陈旧数据降级为备注不阻断；
//   e. 数据库文件不存在或打不开：此根下所有工作树全部 skip，「数据库缺席，不做删除」；
//   f. git status --porcelain -uall 为空（-uall 抗 status.showUntrackedFiles
//      配置）；ignored 逐文件展开（ls-files -o -i -z）里没有命中「珍贵模式」
//      的条目（status 把 ignored 目录折叠成一行，目录内凭据只能靠逐文件
//      检出；命中前先过 BENIGN_DIR_SEGMENTS 良性目录段滤掉编译产物防误报，
//      报告列名收敛到顶层条目、超 8 个截断）。*.properties 命中再过内容级
//      豁免：整文件键都在工具链白名单（sdk.dir/ndk.dir/cmake.dir/flutter.*）
//      的是 IDE 生成的 SDK 指针不是凭据，放行并进报告；其他键、不可解析行、
//      读取失败一律维持阻断。嵌套 git 仓库同样阻断：
//      普通嵌套仓库在 ls-files 里是尾斜杠边界条目，bare 仓库会被展开
//      成文件（按 HEAD+objects/refs/config 同前缀特征识别）——其内部
//      状态都无法评估；但落在良性目录段内的（.build/checkouts、Pods 等
//      依赖检出）不算用户仓库，与珍贵命中走同一豁免。assume-unchanged/skip-worktree
//      标记文件（ls-files -v 小写或 S）同样阻断——其本地修改对 status 隐身；
//   g. HEAD 改动已在远端：HEAD 本身是某 refs/remotes/origin/* 的祖先，或
//      git cherry 逐提交 patch 等价（rebase/单提交 squash 合并），或整支
//      diff(base..HEAD) 的 patch-id 命中 base..ref 上某提交（多提交 squash
//      合并），或对 base 无净改动。patch 等价只保证改动内容在远端，提交
//      对象仍随删除丢弃——squash 工作流要的正是这一点。
//      判定前先对该仓库跑一次 fetch --prune：远端跟踪引用只是本地缓存，
//      远端删过分支后本地 ref 不除会让「已推送」误判；远端不可达整组 skip；
//   h. 没有进程以它为 cwd（POSIX 用 lsof -d cwd -Fn；lsof 缺席时 Linux 退 /proc
//      读 cwd 链接；非 Windows 上检查不可用仍是阻断原因——看不到占用无从
//      归因）。例外：绑定线程全部终结时占用者只可能是已终结线程的残留
//      进程（孤儿代理/模拟器/守护进程），降级为备注放行——干净且已推送的
//      目录删掉只让残留进程 cwd 失效；未绑定目录里的占用无法归因
//      （可能是闲逛进去的活线程），维持阻断。Windows 不做此检查，靠删除
//      失败兜底。汇总行末报告「在用工作树」计数（c/d 命中的目录数）。
//
// 非 git 残留目录里有一类可删：整树只含占位/系统垃圾文件（T3 合并 PR 后删
// 工作树留下的 .keep/.worktree-placeholder——文件自述「safe to delete」——
// 以及 .DS_Store/Thumbs.db 等）的占位目录，同样过 self/绑定/run/占用检查后
// 删除；含其他内容仍标 not-a-worktree 只报告。--apply 收尾顺带 rmdir 本轮
// 删空的二层分组目录（rmdir 只删空目录，非空自然失败跳过）。
//
// 线程绑定/活跃 run/进程占用都可能在扫描期间变化：扫描阶段各取一份快照，
// --apply 真正删除前会对该目录重拍快照并重查 git 状态（dirty/珍贵忽略/HEAD
// 推送状态都可能被并发进程改写），复查一遍收窄 TOCTOU 窗口。
// 残余窗口——线程恰在复查后复活或新绑定该目录——只能靠 T3 提供解绑/互斥
// 接口才能彻底消除。
//
// 删除动作（仅 --apply）：重拍复查通过后先记分支名（symbolic-ref，detached
// 记空），rmSync 递归删目录后 git --git-dir <gitCommonDir> worktree prune
// 注销注册项（不用 worktree remove：spawn 超时会把数万文件的递归删除砍在
// 半途，留下 tracked 全 D 的半删残留），再 git branch -d 兜底删本地分支
//（改动已验证在远端的分支 -d 拒删时改用 -D——含 patch 等价与已推送未合入
// 当前 HEAD 两种；失败保留并注明）。任何一步失败
// 标 failed 继续下一个；绝不结束进程、绝不换更强硬的命令重试。
//
// 数据库只读打开：优先 node:sqlite 的 DatabaseSync(path,{readOnly:true})，
// 退回 sqlite3 -readonly -json CLI，都不行视为数据库缺席。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const req = createRequire(import.meta.url);

// ---------- 参数 ----------
const args = process.argv.slice(2);
const usage = "用法：node t3-worktree-gc.mjs [--apply] [--purge-build [--measure-size]] [--diagnose] [--root <dir>]";
let apply = false;
let rootOverride = null;
let purgeBuild = false;
let measureSize = false;
let diagnose = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") apply = true;
  else if (args[i] === "--purge-build") purgeBuild = true;
  else if (args[i] === "--measure-size") measureSize = true;
  else if (args[i] === "--diagnose") diagnose = true;
  else if (args[i] === "--root") {
    const v = args[++i];
    // 缺值/空白/以 -- 开头：拒绝静默回退——resolve("") 会落到调用者 cwd，
    // --apply --root "$空变量" 会把 cwd 下的目录当工作树根扫描
    if (v === undefined || !v.trim() || v.startsWith("--")) {
      console.error(`--root 需要目录参数\n${usage}`);
      process.exit(2);
    }
    rootOverride = v;
  } else {
    console.error(`未知参数：${args[i]}\n${usage}`);
    process.exit(2);
  }
}

if (measureSize && !purgeBuild) {
  console.error(`--measure-size 需要 --purge-build\n${usage}`);
  process.exit(2);
}

const t3Home = process.env.T3CODE_HOME || join(homedir(), ".t3");
const scanRoot = resolve(rootOverride ?? join(t3Home, "worktrees"));
const dbPath = join(t3Home, "userdata", "statev2.sqlite");
const isWindows = platform() === "win32";

// ---------- 工具 ----------
// 数组传参，禁止拼 shell 字符串；失败不抛异常，由调用处按保守策略处理。
const progress = (text) => console.error(`[进度] ${text}`);
function shErr(cmd, argv, opts = {}) {
  const started = performance.now();
  const heavy = ["du", "lsof"].includes(cmd) || argv.some((a) => ["status", "ls-files", "fetch", "submodule", "cherry", "patch-id", "diff", "log"].includes(a));
  const label = `${cmd} ${argv.join(" ")}`;
  if (heavy) progress(`开始 ${label}`);
  const done = (result) => {
    const ms = Math.round(performance.now() - started);
    if (heavy || ms >= 1000) progress(`${result} ${label}（${ms}ms）`);
  };
  try {
    const out = execFileSync(cmd, argv, {
      encoding: "utf8",
      timeout: opts.timeout ?? 15000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, // 默认 1MB 太小，status/ref 列表在巨型仓库会超限
      input: opts.input, // 透传 stdin（git patch-id 读标准输入）；stdio[0] 必须 pipe 才生效
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    done("完成");
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    done(`失败 ${e.code ?? e.status ?? "unknown"}${e.signal ? ` signal=${e.signal}` : ""}`);
    return { ok: false, out: "", err: String(e.stderr?.toString() || e.message).trim() };
  }
}
const sh = (cmd, argv, opts = {}) => {
  const r = shErr(cmd, argv, opts);
  return r.ok ? r.out : null;
};

// 忽略文件里的「珍贵模式」：凭据类文件类型，命中任何路径段即阻断删除
//（大小写不敏感）。node_modules / 构建产物这类 ignored 不命中，照常可删、
// 条目名截断列进报告。
const PRECIOUS_PATTERNS = [
  // 环境变量与常藏凭据的配置
  ".env*",
  "*.properties",
  "*.tfvars",
  "secrets.*",
  "*.token",
  // 密钥 / 证书 / 钥匙串
  "*.pem",
  "*.key",
  "*.crt",
  "*.cer",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.keytab",
  "*.ppk",
  "*.mobileprovision",
  "*.ovpn",
  "id_*",
  // 凭据命名、口令库与各平台账号目录/文件
  "*credential*",
  "*secret*",
  ".htpasswd",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".ssh",
  ".gnupg",
  ".aws",
  ".pypirc",
  ".npmrc",
  ".gitconfig",
  ".dockercfg",
  ".git-crypt",
  "hosts.yml",
  ".kube",
  ".docker",
  ".azure",
  "local.settings.json",
  "kubeconfig*",
  "*.serviceaccount*",
  "*.tfstate*",
  // 本地数据库
  "*.sqlite*",
  "*.db",
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRECIOUS_RE = PRECIOUS_PATTERNS.map(
  (p) => new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`, "i")
);
// 路径子串模式：多段组合的凭据位置（单段模式表达不了的）
const PRECIOUS_SUBSTRINGS = [".config/gh/", ".config/gcloud/"];
const isPrecious = (p) =>
  p.split("/").some((seg) => seg && PRECIOUS_RE.some((re) => re.test(seg))) ||
  PRECIOUS_SUBSTRINGS.some((s) => p.includes(s));

// *.properties 珍贵命中的内容级豁免：Android/Flutter 工具链生成的
// local.properties 只写 SDK 路径与版本元数据（sdk.dir 等），没有凭据。
// 逐文件读内容——全部键落在白名单才豁免；出现任何其他键（key.properties
// 的 storePassword、gradle.properties 的口令项）、不可解析行、读取失败、
// 超限或非普通文件，一律维持珍贵判定（失败方向永远是阻断）。
const BENIGN_PROPERTIES_KEYS = new Set([
  "sdk.dir",
  "ndk.dir",
  "cmake.dir",
  "flutter.sdk",
  "flutter.buildmode",
  "flutter.versionname",
  "flutter.versioncode",
  "flutter.minsdkversion",
  "flutter.targetsdkversion",
  "flutter.compilesdkversion",
  "flutter.ndkversion",
]);
// 奇数个结尾反斜杠 = properties 续行，下一行是值的一部分不是键
const endsContinuation = (s) => {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++;
  return n % 2 === 1;
};
function propertiesBenign(abs) {
  if (!abs.toLowerCase().endsWith(".properties")) return false;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size > 64 * 1024) return false;
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  let cont = false;
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.trim();
    if (cont) {
      cont = endsContinuation(line);
      continue;
    }
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([A-Za-z0-9._-]+)(?=[\s:=]|$)/.exec(line);
    if (!m || !BENIGN_PROPERTIES_KEYS.has(m[1].toLowerCase())) return false;
    cont = endsContinuation(line);
  }
  return true;
}

// 良性目录段：路径任一段命中即跳过珍贵匹配——build/target 等产物目录里的
// 编译输出（如 **/Credentials.class）会误中 *credential* 之类模式。
// 已知取舍：被丢进产物目录的凭据（tmp/secrets.env 之类）会被滤过——
// 不加这层过滤的话 node_modules 里的类凭据文件名会让所有 JS 工作树不可删。
const BENIGN_DIR_SEGMENTS = [
  "node_modules",
  "dist",
  "build",
  ".build", // SwiftPM 构建目录：checkouts/repositories 里是真实但可重建的依赖检出
  "target",
  "out",
  "coverage",
  ".gradle",
  ".cxx",
  ".next",
  ".turbo",
  ".cache",
  "artifacts",
  "tmp",
  "temp",
  ".tmp", // 变体：musiver 用它放 app-store-derived（Xcode 派生数据克隆）
  "vendor",
  "pods", // CocoaPods 检出
  "carthage", // Carthage/Checkouts 检出
  "sourcepackages", // DerivedData 下的 SwiftPM checkout 区
  "deriveddata",
  "checkouts", // SwiftPM/Carthage 依赖检出目录的通用名
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".dart_tool",
  ".idea",
  ".vscode",
];
const BENIGN_SET = new Set(BENIGN_DIR_SEGMENTS.map((s) => s.toLowerCase()));
const hasBenignSegment = (p) => p.split("/").some((seg) => seg && BENIGN_SET.has(seg.toLowerCase()));

// 非 git 残留里的占位目录白名单：T3 合并 PR 后会删掉工作树并写
// .keep/.worktree-placeholder 维持线程 cwd（文件自述 safe to delete）；
// .DS_Store/Thumbs.db 等是系统浏览副产物。整树逐条目递归命中白名单（或为空）
// 才算占位目录；出现任何其他文件即放弃，维持 not-a-worktree 只报告。
const PLACEHOLDER_NAMES = new Set([
  ".keep",
  ".worktree-placeholder",
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  ".localized",
]);
function placeholderOnly(dir) {
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return false; // 读不了的目录不当占位目录
    }
    for (const e of ents) {
      if (++seen > 2000) return false;
      if (e.isDirectory()) {
        stack.push(join(d, e.name)); // 目录本身不豁免——进去看内容
        continue;
      }
      if (!e.isFile()) return false; // symlink/FIFO 等一律不删
      if (!PLACEHOLDER_NAMES.has(e.name.toLowerCase())) return false;
    }
  }
  return true;
}

const norm = (p) => resolve(p).replace(/[\\/]+$/, "");
const tryReal = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

// ---------- 数据库（只读） ----------
// 返回 { all(sql) } 或 null（文件缺席/两种后端都打不开）。查询一律无参数，
// worktreePath 匹配放到 JS 侧做，CLI 兜底也能复用同一组 SQL。
function openDb() {
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = req("node:sqlite");
    const d = new DatabaseSync(dbPath, { readOnly: true });
    return { all: (sql) => d.prepare(sql).all() };
  } catch {}
  if (sh("sqlite3", ["--version"]) !== null) {
    return {
      all: (sql) => {
        const r = shErr("sqlite3", ["-readonly", "-json", dbPath, sql]);
        if (!r.ok) throw new Error(`sqlite3 查询失败：${r.err}`);
        try {
          return JSON.parse(r.out || "[]");
        } catch {
          return [];
        }
      },
    };
  }
  return null;
}

// 线程终结判定：settledOverride='settled' / archived / deleted 任一。
// archived_at、deleted_at 是列；payload_json 里同义字段 archivedAt/deletedAt 兜底。
function threadSettled(t) {
  let p = {};
  try {
    p = JSON.parse(t.payload_json);
  } catch {}
  return (
    p.settledOverride === "settled" ||
    t.archived_at != null ||
    p.archivedAt != null ||
    t.deleted_at != null ||
    p.deletedAt != null
  );
}

// 委派子线程的终态白名单：threads 行的 settledOverride 对
// thread:delegated-task:* / thread:provider:* 子线程永不写入（T3 数据缺口），
// delegate_task 的真实完结落在 orchestration_v2_projection_subagents.status。
// 未知状态一律不当终态——宁可把还活着的子线程错判为阻塞，不可反向放行。
const SUBAGENT_TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

// worktreePath → 绑定线程列表；另建 realpath 别名键，容忍符号链接路径差异。
function loadState(db) {
  const rows = db.all(
    `SELECT thread_id, title, payload_json, archived_at, deleted_at
     FROM orchestration_v2_projection_threads
     WHERE json_extract(payload_json,'$.worktreePath') IS NOT NULL`
  );
  // 子线程 id → subagents 关联行计数。child_thread_id / provider_thread_id
  // 两列都可能指向绑定工作树的子线程；关联行全部终态才视该线程终结。
  // 表缺席（最小库/旧库/查询失败）= 无信息，不放宽任何判定。
  const subByThread = new Map();
  try {
    for (const r of db.all(
      `SELECT child_thread_id, provider_thread_id, status
       FROM orchestration_v2_projection_subagents`
    )) {
      for (const id of [r.child_thread_id, r.provider_thread_id]) {
        if (typeof id !== "string" || !id) continue;
        const a = subByThread.get(id) ?? { total: 0, terminal: 0 };
        a.total += 1;
        if (SUBAGENT_TERMINAL.has(String(r.status))) a.terminal += 1;
        subByThread.set(id, a);
      }
    }
  } catch {}
  const byWt = new Map();
  const add = (key, t) => {
    const arr = byWt.get(key) ?? [];
    arr.push(t);
    byWt.set(key, arr);
  };
  for (const t of rows) {
    let p = {};
    try {
      p = JSON.parse(t.payload_json);
    } catch {}
    const wp = typeof p.worktreePath === "string" ? norm(p.worktreePath) : null;
    if (!wp) continue;
    const sub = subByThread.get(t.thread_id);
    const rec = {
      id: t.thread_id,
      title: String(t.title ?? "").replace(/\s+/g, " ").slice(0, 60),
      delegated: t.thread_id.startsWith("thread:delegated-task:") || sub != null,
      settled: threadSettled(t) || (sub != null && sub.terminal === sub.total),
    };
    add(wp, rec);
    const rp = tryReal(wp);
    if (rp && rp !== wp) add(rp, rec);
  }
  const activeRuns = new Set(
    db
      .all(
        `SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
         WHERE status IN ('queued','preparing','starting','running','waiting')`
      )
      .map((r) => r.thread_id)
  );
  return { byWt, activeRuns };
}

// ---------- 候选目录收集 ----------
// <root>/<工作树> 或 <root>/<分组>/<工作树> 两种布局。分组只下一层。
function isGitDir(d) {
  try {
    return statSync(d).isDirectory() && sh("git", ["-C", d, "rev-parse", "--git-dir"]) !== null;
  } catch {
    return false;
  }
}
function subdirs(d) {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(d, e.name))
      .sort();
  } catch {
    return [];
  }
}
function candidates(root) {
  const out = [];
  for (const d of subdirs(root)) {
    if (isGitDir(d)) {
      out.push(d);
      continue;
    }
    // 有 .git 条目但 rev-parse 失败：gitfile 失效的工作树残留，自身报 not-a-worktree
    const subs = existsSync(join(d, ".git")) ? [] : subdirs(d);
    if (subs.length === 0) out.push(d);
    else out.push(...subs); // 分组目录：其下才是工作树
  }
  return out;
}

// ---------- 进程占用（POSIX） ----------
// 返回 Map<cwd路径, pid[]>（空 Map = 枚举成功、无占用），null = 检查不可用。
// Windows 恒 null（不查，靠删除失败兜底）；非 Windows 上 null 会算阻断原因。
function computeOccupants() {
  if (isWindows) return null;
  const map = new Map();
  const push = (p, pid) => {
    const a = map.get(p) ?? [];
    a.push(pid);
    map.set(p, a);
  };
  const out = sh("lsof", ["-d", "cwd", "-Fn"], { timeout: 60000 });
  if (out !== null) {
    let pid = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("n") && pid) push(line.slice(1), pid);
    }
    return map;
  }
  if (platform() !== "linux") return null; // 无 lsof 又非 Linux：检查缺席
  // /proc 兜底：整目录枚举失败才算不可用；单个进程 cwd 读不到只跳过它
  try {
    for (const e of readdirSync("/proc")) {
      if (!/^\d+$/.test(e)) continue;
      try {
        push(readlinkSync(`/proc/${e}/cwd`), e);
      } catch {}
    }
    return map;
  } catch {
    return null;
  }
}

// ---------- 外部状态快照 ----------
// DB 与进程占用都是易变状态：扫描阶段各取一份；--apply 删除前重拍复查。
function snapshotDb() {
  const db = openDb();
  if (!db) return { state: null, note: null };
  try {
    return { state: loadState(db), note: null };
  } catch (e) {
    return { state: null, note: `数据库查询失败，按缺席处理：${e.message}` };
  }
}

// DB 里同一工作树可能有多种路径拼写（如 /tmp 与 /private/tmp）：原路径与
// realpath 两个键下的绑定列表合并，按 thread_id 去重。
function boundThreads(byWt, dir, wtReal) {
  const m = new Map();
  for (const key of new Set([norm(dir), wtReal].filter(Boolean))) {
    for (const t of byWt.get(key) ?? []) m.set(t.id, t);
  }
  return [...m.values()];
}

// 依赖快照的判定：c. 线程全终结、d. 无活跃 run、h. 无进程占用。
// 返回 { reasons, inUse }；unbound/降级项顺带写进 notes（可删报告用）。
// inUse = 有未终结绑定线程或未终结线程带进行中 run——即「在用工作树」。
function snapshotReasons(dir, wtReal, snap, occ, notes) {
  const reasons = [];
  let inUse = false;
  let bound = [];
  if (!snap.state) {
    reasons.push(snap.note ?? "数据库缺席，不做删除");
  } else {
    bound = boundThreads(snap.state.byWt, dir, wtReal);
    if (bound.length === 0) notes.push("unbound");
    const unsettled = bound.filter((t) => !t.settled);
    if (unsettled.length) {
      inUse = true;
      const mains = unsettled.filter((t) => !t.delegated);
      const dels = unsettled.filter((t) => t.delegated);
      const fmt = (list, label) =>
        `${label} ${list.length} 个未终结（${list.map((t) => t.title).join("；")}）`;
      const parts = [];
      if (mains.length) parts.push(fmt(mains, "主线程"));
      if (dels.length) parts.push(fmt(dels, "委派线程"));
      reasons.push(parts.join("、"));
    }
    // 活跃 run 只统计未终结线程：已终结线程上的 running 行是 runs 投影
    // 滞留（子线程完工后状态偶发停更），属陈旧数据——降级为备注不阻断
    const running = bound.filter((t) => !t.settled && snap.state.activeRuns.has(t.id));
    if (running.length) {
      inUse = true;
      reasons.push(`${running.length} 个绑定线程有进行中的 run（${running.map((t) => t.title).join("；")}）`);
    }
    const stale = bound.filter((t) => t.settled && snap.state.activeRuns.has(t.id));
    if (stale.length) notes.push(`${stale.length} 个已终结线程残留 running 状态的 run 投影`);
  }
  if (occ === null) {
    // Windows 不查占用；POSIX 查不到时保守 skip（看不到占用就无从归因）
    if (!isWindows) reasons.push("进程占用检查不可用（lsof 缺席且非 Linux /proc）");
  } else {
    const pids = [];
    for (const [p, ids] of occ) {
      const pr = tryReal(p) ?? norm(p);
      if (inside(pr, wtReal) || inside(norm(p), norm(dir))) pids.push(...ids);
    }
    if (pids.length) {
      const msg = `进程占用：pid ${[...new Set(pids)].join(", ")}`;
      // 绑定线程全部终结时，占用者只可能是已终结线程的残留进程（孤儿
      // 代理、模拟器、守护进程）——降级为备注放行：已验证干净+已推送的
      // 目录删掉只让残留进程 cwd 失效，没有数据损失；未绑定目录里的
      // 占用无法归因（可能是闲逛进去的活线程/用户进程），维持阻断
      if (bound.length && bound.every((t) => t.settled)) notes.push(`${msg}（绑定线程已全部终结，判为残留进程）`);
      else reasons.push(msg);
    }
  }
  return { reasons, inUse };
}

// 远端跟踪引用只是本地缓存：远端分支被删/强推后本地 ref 仍在，「已推送」
// 会误判。每个公共 git 目录跑一次 fetch --prune 刷新后再判（worktree 共享
// refs，按 gitCommon 去重）；取不到远端视为无法验证，该仓库整组 skip。
const fetchCache = new Map(); // gitCommon → boolean
// norm(dir) → 该树分支允许 branch -D：HEAD 改动已验证在远端（祖先已推送
// 或 patch/整支等价/无净改动）。-d 只认「合入当前 HEAD」，不查远端祖先——
// 推上远端其他分支的支端同样会被拒，-D 丢弃的只是本地引用不丢内容。
const forceDelOk = new Set();
function refreshRemote(gitCommon, fresh = false) {
  if (fresh) fetchCache.delete(gitCommon); // 删除前复查不复用扫描期的旧快照
  if (!fetchCache.has(gitCommon)) {
    // 禁交互凭据提示：缺 HTTPS/SSH 凭据时 git 会经 /dev/tty 弹提示卡到超时；
    // 让它们直接失败走「远端不可达」分支。
    const env = { GIT_TERMINAL_PROMPT: "0" };
    // SSH 命令已配（GIT_SSH_COMMAND/GIT_SSH 环境变量或 core.sshCommand 配置，
    // env 优先级最高会整个顶掉用户配置）就尊重它；三者皆无才注入 BatchMode。
    const hasSshCmd =
      process.env.GIT_SSH_COMMAND ||
      process.env.GIT_SSH ||
      sh("git", ["--git-dir", gitCommon, "config", "--get", "core.sshCommand"]);
    if (!hasSshCmd) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    fetchCache.set(
      gitCommon,
      shErr("git", ["--git-dir", gitCommon, "fetch", "origin", "--prune"], { timeout: 120000, env }).ok
    );
  }
  return fetchCache.get(gitCommon);
}

// diff 文本 → patch-id 集合：git patch-id 从 stdin 读，git log -p 多提交
// 输入按 "commit <sha>" 行分节、逐提交各产一个 id；单个 git diff 输出一 id。
function patchIdsOf(diffText) {
  const r = sh("git", ["patch-id", "--stable"], { input: diffText, maxBuffer: 256 * 1024 * 1024 });
  if (r === null) return null;
  return new Set(r.split("\n").map((l) => l.split(/\s/)[0]).filter(Boolean));
}

// g. HEAD 改动是否已在远端，按顺序取首个成立的方式，返回报告文案：
//   - HEAD 是某 origin ref 的祖先（常规推送、merge 合并后远端分支仍在）；
//   - git cherry <ref> HEAD 无 '+'：逐提交 patch 等价（rebase 合并、单提交 squash）；
//   - 整支 diff(base..HEAD) 的 patch-id 命中 base..ref 上某提交（多提交 squash：
//     N 个本地提交被压成远端 1 个，逐提交 cherry 对不上，整支 diff 能对上）；
//   - diff(base..HEAD) 为空：相对上游无净改动，内容层面无可丢。
// patch 等价只证明改动内容已进远端，提交对象仍随删除丢弃——squash 合并的
// 本地分支正是这个形态；内容对不上的孤立提交仍按未推送阻断。
function headShipped(dir, refs) {
  for (const ref of refs)
    if (shErr("git", ["-C", dir, "merge-base", "--is-ancestor", "HEAD", ref]).ok)
      return "HEAD 已推送";
  for (const ref of refs) {
    const c = sh("git", ["-C", dir, "cherry", ref, "HEAD"]);
    if (c !== null && !c.split("\n").some((l) => l.startsWith("+")))
      return `HEAD 各提交 patch 等价于 ${ref} 上的提交（rebase/squash 合并）`;
  }
  for (const ref of refs) {
    const base = sh("git", ["-C", dir, "merge-base", "HEAD", ref]);
    if (!base) continue;
    const diff = sh("git", ["-C", dir, "diff", base, "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
    if (diff === null) continue;
    if (!diff.trim()) return `相对 ${ref} 无净改动`;
    const bp = patchIdsOf(diff)?.values().next().value;
    if (!bp) continue;
    // 上游侧逐提交 patch-id：git log -p 的输出按 commit 行分节，patch-id
    // 逐提交各产一行；封顶 400 个提交，日志体积上限与 ls-files 同规格
    const up = sh(
      "git",
      ["-C", dir, "log", "--no-merges", "-n", "400", "-p", `${base}..${ref}`],
      { maxBuffer: 256 * 1024 * 1024, timeout: 60000 }
    );
    if (up === null) continue;
    if (patchIdsOf(up)?.has(bp)) return `HEAD 整支改动等价于 ${ref} 上的提交（squash 合并）`;
  }
  return null;
}

// f/g. git 侧判定：未提交变更、忽略文件里的珍贵内容、HEAD 已推送、
// assume-unchanged/skip-worktree 标记。扫描与删除前复查共用：间隔期间
// 后台进程可能新写 .env 或本地提交。notes 只在扫描阶段收集 ignored 列名；
// refetch=true 时强制重跑 fetch，复查不用扫描期的远端快照。
function gitStateReasons(dir, notes, gitCommon, refetch = false) {
  const reasons = [];
  // FSMonitor 钩子/守护进程陈旧或误报时，被修改的 index 条目仍标
  // fsmonitor-valid，status 漏报本地编辑（ls-files -v 也只是普通 H），
  // 而 worktree remove 信同一份索引；untrackedCache 同理可藏未跟踪文件。
  // 一切读工作树状态的 git 调用强制关两者，退化回真实 stat 扫描。
  const NF = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
  // -uall 强制逐文件展开并覆盖 status.showUntrackedFiles=no 配置——
  // 配置为 no 时普通 untracked 文件完全不报，会把脏树误判干净
  const st = sh("git", [...NF, "-C", dir, "status", "--porcelain", "-uall"]);
  if (st === null) reasons.push("git status 执行失败");
  else {
    const dirty = st.split("\n").filter(Boolean);
    if (dirty.length) reasons.push(`${dirty.length} 个未提交文件`);
  }

  // ignored 逐文件展开（ls-files 不受折叠/status 配置影响）：先过良性
  // 目录段滤掉编译产物防误报，剩余逐文件匹配珍贵模式。输出可能 10MB+
  //（数万 ignored 文件），缓冲给足、超时放宽
  const ls = sh("git", [...NF, "-C", dir, "ls-files", "-o", "-i", "--exclude-standard", "-z"], { maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
  if (ls === null) reasons.push("git ls-files 执行失败");
  else {
    const ignored = ls.split("\0").filter(Boolean);
    // 尾斜杠 = ls-files 拒绝下探的目录（嵌套 git 仓库/不可读目录）：内部
    // 凭据与未推送提交对它不可见，一律阻断——但落在良性目录段内的是
    // 依赖检出（SwiftPM .build/checkouts、Pods 等可重建产物），不算
    // 用户仓库，与下方 bare 检测同一豁免。
    // bare 嵌套仓库没有 .git 边界会被展开成文件：同一前缀下 HEAD +
    // objects/|refs/|config 共存即按仓库判定（空 bare 有 HEAD+config，
    // 有提交的有 HEAD+objects/refs）；前缀命中良性目录段才放行（包内
    // git 夹具不算用户仓库）。
    const nested = new Set(ignored.filter((p) => p.endsWith("/") && !hasBenignSegment(p)));
    const bareMarks = new Map(); // 目录前缀 → 出现过的仓库特征
    const markBare = (prefix, k) => {
      if (!prefix) return;
      const s = bareMarks.get(prefix) ?? new Set();
      s.add(k);
      bareMarks.set(prefix, s);
    };
    for (const p of ignored) {
      if (p.endsWith("/")) continue;
      const oi = p.indexOf("/objects/");
      if (oi > 0) markBare(p.slice(0, oi), "objs");
      const ri = p.indexOf("/refs/");
      if (ri > 0) markBare(p.slice(0, ri), "refs");
      if (p.endsWith("/HEAD")) markBare(p.slice(0, -5), "head");
      if (p.endsWith("/config")) markBare(p.slice(0, -7), "config");
    }
    for (const [d, s] of bareMarks)
      if (!hasBenignSegment(d) && s.has("head") && (s.has("objs") || s.has("refs") || s.has("config")))
        nested.add(`${d}/`);
    if (nested.size) reasons.push(`含嵌套仓库/不可枚举目录：${[...nested].join("、")}`);
    // 珍贵命中再过一道内容级豁免：*.properties 整文件键都在工具链白名单
    // （sdk.dir 等）说明是 IDE 生成的 SDK 指针不是凭据；其他模式与其他键
    // 维持阻断。豁免件写进 notes 保持可审计
    const precious = [];
    const propExempt = [];
    for (const p of ignored.filter((p) => !hasBenignSegment(p)).filter(isPrecious))
      (propertiesBenign(join(dir, p)) ? propExempt : precious).push(p);
    if (propExempt.length)
      notes.push(`${propExempt.length} 个 properties 仅含 SDK 路径键已豁免（${propExempt.join("、")}）`);
    if (precious.length) reasons.push(`含珍贵忽略文件：${precious.join("、")}`);
    else if (ignored.length) {
      // 展示收敛到顶层条目（多段路径取首段加 /），超 8 个截断
      const tops = [...new Set(ignored.map((p) => (p.includes("/") ? `${p.split("/")[0]}/` : p)))];
      notes.push(`忽略文件 ${ignored.length} 个（${tops.slice(0, 8).join("、")}${tops.length > 8 ? "、…" : ""}）`);
    }
  }

  // assume-unchanged/skip-worktree 标记的本地修改对 status 隐身：
  // ls-files -v 标签小写（assume-unchanged）或 S（skip-worktree）一律阻断
  // git 子模块（索引里 mode 160000 的 gitlink）：内部 ignored/未推送状态对所有外层检查不可见，
  // 且 worktree remove 对含子模块的工作树本就要求双重 --force——一律阻断。
  // 与标记检查合并成一次 ls-files -s -v（每行「<标签> <mode> <oid> <stage>\t<path>」），
  // 比 git submodule status 快一个数量级，且连没有 .gitmodules 映射的 gitlink 也能识别。
  const lv = sh("git", [...NF, "-C", dir, "ls-files", "-s", "-v", "-z"]);
  if (lv === null) reasons.push("git ls-files -s -v 执行失败");
  else {
    const entries = lv.split("\0").filter(Boolean).map((l) => {
      const tab = l.indexOf("\t");
      return { tag: l[0], mode: l.slice(2, l.indexOf(" ", 2)), path: l.slice(tab + 1) };
    });
    const flagged = entries.filter((e) => /^[a-zS]$/.test(e.tag)).map((e) => e.path);
    if (flagged.length)
      reasons.push(`含 assume-unchanged/skip-worktree 标记文件 ${flagged.length} 个（${flagged.slice(0, 8).join("、")}${flagged.length > 8 ? "、…" : ""}）`);
    const subs = new Set(entries.filter((e) => e.mode === "160000").map((e) => e.path));
    if (subs.size) reasons.push(`含 git 子模块（其内部本地状态不可评估）：${subs.size} 个`);
  }

  if (sh("git", ["--git-dir", gitCommon, "remote", "get-url", "origin"]) === null)
    reasons.push("无 origin 远端配置");
  else if (!refreshRemote(gitCommon, refetch))
    reasons.push("远端不可达，无法验证推送状态（fetch origin --prune 失败）");
  else {
    const refs = (sh("git", ["-C", dir, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"]) ?? "")
      .split("\n")
      .filter(Boolean);
    if (refs.length === 0) reasons.push("无 refs/remotes/origin/* 远端引用");
    else {
      const shipped = headShipped(dir, refs);
      if (!shipped) reasons.push("HEAD 不在任何 origin 分支上（本地提交未推送）");
      else {
        notes.push(shipped);
        forceDelOk.add(norm(dir)); // 任一种「已在远端」成立，-D 都不丢内容
      }
    }
  }
  return reasons;
}

// ---------- 构建产物清理（--purge-build） ----------
// 只认可重建的通用产物目录，且必须是 git ignored 目录（ls-files --directory
// 折叠出的整目录条目）：cargo target（带 .rustc_info.json 或 CACHEDIR.TAG）、
// SwiftPM .build、Xcode 派生数据（目录名 DerivedData，或含 ModuleCache.noindex
// / Build/Intermediates.noindex 的自定义 -derivedDataPath）、node_modules、
// .gradle。项目私有的产物目录不在此列——不往通用脚本里塞某个仓库的布局。
function isPurgeTarget(abs, name) {
  const has = (...p) => existsSync(join(abs, ...p));
  switch (name.toLowerCase()) {
    case "target":
      return has(".rustc_info.json") || has("CACHEDIR.TAG") || ["debug", "release"].some((d) => has(d, ".cargo-lock") || has(d, ".cargo-artifact-lock") || has(d, ".fingerprint"));
    case ".build":
    case "deriveddata":
    case "node_modules":
    case ".gradle":
      return true;
    default:
      return has("ModuleCache.noindex") || has("Build", "Intermediates.noindex");
  }
}
function purgeTargets(dir) {
  const out = sh("git", ["-c", "core.fsmonitor=false", "-C", dir, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (out === null) return null;
  const found = [];
  const walk = (rel, depth) => {
    if (purgePathReason(dir, rel)) return;
    const abs = join(dir, rel);
    const name = rel.replace(/\/$/, "").split("/").pop();
    if (isPurgeTarget(abs, name)) return found.push(rel.replace(/\/$/, ""));
    // 折叠条目（如 .tmp/）内部再下探两层找派生数据，不越过符号链接
    if (depth >= 2) return;
    let ents = [];
    try {
      ents = readdirSync(abs, { withFileTypes: true });
    } catch {}
    for (const e of ents) if (e.isDirectory()) walk(`${rel}${e.name}/`, depth + 1);
  };
  for (const p of out.split("\0")) if (p.endsWith("/")) walk(p, 0);
  return found;
}
// 每个路径段都必须是真目录；尤其阻断 Windows junction 和祖先链接。
function purgePathReason(dir, rel) {
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (!r || r === ".." || r.startsWith(`..${sep}`) || resolve(dir, r) !== abs || !inside(abs, dir))
    return "目标不在工作树内";
  let p = dir;
  try {
    if (lstatSync(p).isSymbolicLink()) return "工作树是符号链接/junction";
    for (const part of r.split(sep)) {
      p = join(p, part);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) return "目标或祖先不是普通目录（符号链接/junction）";
    }
    if (!inside(realpathSync(abs), realpathSync(dir))) return "目标 realpath 越界";
  } catch {
    return "目标目录不可读取";
  }
  return null;
}
function purgeTargetReason(dir, rel) {
  const pathReason = purgePathReason(dir, rel);
  if (pathReason) return pathReason;
  const abs = join(dir, rel);
  if (!isPurgeTarget(abs, rel.split("/").pop())) return "不再符合构建产物规则";
  const NF = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", dir];
  // literal pathspec 防目标名中的通配符改变查询范围；包括强制添加/索引隐藏文件。
  const spec = `:(literal)${rel}`;
  const gitReason = (() => {
    const tracked = sh("git", [...NF, "ls-files", "--cached", "-z", "--", spec]);
    if (tracked === null || tracked) return "目标含跟踪文件或跟踪检查失败";
    const untracked = sh("git", [...NF, "ls-files", "-o", "--exclude-standard", "-z", "--", spec]);
    if (untracked === null || untracked) return "目标含非 ignored 文件或检查失败";
    if (!shErr("git", [...NF, "check-ignore", "-q", "--", `${rel}/`]).ok) return "目标不再是 ignored 目录";
    return null;
  })();
  // Git 检查期间路径或标记也可能被替换，再检查一次。路径原因优先报告：目录被换成
  // 符号链接/junction 时 git 也会把它当成非 ignored 文件，那只是症状。
  return purgePathReason(dir, rel) || gitReason || (!isPurgeTarget(abs, rel.split("/").pop()) ? "不再符合构建产物规则" : null);
}
function duBytes(abs) {
  const o = sh("du", ["-sk", abs], { timeout: 120000 });
  const kb = o && /^\d+(?:\s|$)/.test(o) ? Number(o.split(/\s/)[0]) : NaN;
  return Number.isFinite(kb) ? kb * 1024 : null;
}
const fmtBytes = (b) => (b === null ? "未知" : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)}G` : `${Math.round(b / 2 ** 20)}M`);

// ---------- 主流程 ----------
const rows = []; // { verdict, rel, branch, detail }
const counts = { delete: 0, deleted: 0, skip: 0, "not-a-worktree": 0, failed: 0, purge: 0, purged: 0 };
let purgeTotal = 0;
let purgeUnknown = false;
const addPurgeBytes = (sized) => {
  for (const [, b] of sized) {
    if (b === null) purgeUnknown = true;
    else purgeTotal += b;
  }
};
const report = (verdict, rel, detail, branch) => {
  rows.push({ verdict, rel, detail, branch });
  counts[verdict]++;
  console.log(`${verdict.padEnd(14)} ${rel}${branch ? `  branch=${branch}` : ""}${detail ? `  ${detail}` : ""}`);
};

if (!existsSync(scanRoot)) {
  console.log(`扫描根目录不存在：${scanRoot}`);
  process.exit(0);
}

console.log(`扫描根：${scanRoot}${apply ? "（--apply）" : "（dry-run）"}`);
progress("读取线程绑定与进程占用快照");
const dbSnap = snapshotDb();
const occSnap = computeOccupants();
const cwdReal = tryReal(process.cwd()) ?? norm(process.cwd());
let inUseDirs = 0; // 扫描期判定为「在用」（未终结线程绑定/进行中 run）的目录数

// 报告行统一 / 分隔：Windows 下 relative() 产出 \，而同行 detail 里的
// git 路径（ls-files 等）恒为 /——两种方言混在一行不利于下游按 / 匹配
const relOf = (p) => (relative(scanRoot, p) || p).replaceAll(sep, "/");

progress("收集候选工作树");
for (const dir of candidates(scanRoot)) {
  const rel = relOf(dir);
  progress(`扫描 ${rel}`);
  const reasons = [];
  const notes = [];
  const wtReal = tryReal(dir) ?? norm(dir);

  // b. git 链接工作树判定。非 git/gitfile 失效的残留里，整树只含占位/系统
  //    垃圾文件的是「占位目录」（T3 合并 PR 后删工作树留的 cwd 占位，文件
  //    自述 safe to delete）——过同样的 self/绑定/占用检查后删除；含其他
  //    内容的维持 not-a-worktree 只报告。
  const gitDirOut = sh("git", ["-C", dir, "rev-parse", "--git-dir"]);
  if (gitDirOut === null) {
    if (!placeholderOnly(dir)) {
      report("not-a-worktree", rel, "非 git 目录或 gitfile 失效的残留", null);
      continue;
    }
    if (inside(cwdReal, wtReal)) reasons.push("调用者 cwd 位于此目录内（self）");
    const sn = snapshotReasons(dir, wtReal, dbSnap, occSnap, notes);
    reasons.push(...sn.reasons);
    if (sn.inUse) inUseDirs++;
    if (reasons.length) {
      report("skip", rel, [...reasons, ...notes].join("；"), null);
      continue;
    }
    notes.push("占位目录");
    if (!apply) {
      report("delete", rel, notes.join("；"), null);
      continue;
    }
    // 删除前重拍绑定/占用复查（与工作树同一 TOCTOU 收窄逻辑）
    const rePh = snapshotReasons(dir, wtReal, snapshotDb(), computeOccupants(), []).reasons;
    if (rePh.length) {
      report("skip", rel, `删除前复查发现阻断：${rePh.join("；")}`, null);
      continue;
    }
    try {
      rmSync(dir, { recursive: true }); // 内容已逐条核验为占位文件
    } catch {}
    if (existsSync(dir)) report("failed", rel, "占位目录删除失败", null);
    else report("deleted", rel, notes.join("；"), null);
    continue;
  }
  const branch = sh("git", ["-C", dir, "symbolic-ref", "-q", "--short", "HEAD"]);
  const commonOut = sh("git", ["-C", dir, "rev-parse", "--git-common-dir"]) ?? gitDirOut;
  const gitDir = tryReal(resolve(dir, gitDirOut)) ?? resolve(dir, gitDirOut);
  const gitCommon = tryReal(resolve(dir, commonOut)) ?? resolve(dir, commonOut);

  // a. 自己所在的工作树永不删
  if (inside(cwdReal, wtReal)) reasons.push("调用者 cwd 位于此工作树内（self）");

  // b. 独立 clone（git-dir == git-common-dir）直接 skip
  if (gitDir === gitCommon) {
    reasons.push("独立 clone，非链接工作树");
    report("skip", rel, [...reasons, ...notes].join("；"), branch);
    continue;
  }

  // c/d/h. 依赖快照的判定（线程绑定、活跃 run、进程占用）
  const sn = snapshotReasons(dir, wtReal, dbSnap, occSnap, notes);
  reasons.push(...sn.reasons);
  if (sn.inUse) inUseDirs++;

  // 已有不可回收的硬阻断时无需遍历 ignored 文件或联网；诊断模式才收集全部原因。
  if (reasons.length && !diagnose) {
    report("skip", rel, [...reasons, ...notes].join("；"), branch);
    continue;
  }
  // f/g. git 侧判定（未提交变更、珍贵忽略文件、HEAD 已推送）
  reasons.push(...gitStateReasons(dir, notes, gitCommon));

  if (reasons.length) {
    report("skip", rel, [...reasons, ...notes].join("；"), branch);
    // 只因 git 侧原因保留的树（非 self、无未终结线程/活跃 run/不可归因占用）
    // 可单删构建产物：产物全在 ignored 区，不碰任何跟踪或未提交内容
    if (purgeBuild && !inside(cwdReal, wtReal) && sn.reasons.length === 0) {
      const targets = purgeTargets(dir);
      if (targets?.length) {
        const sized = targets.map((t) => [t, measureSize ? duBytes(join(dir, t)) : null]);
        const sum = sized.some(([, b]) => b === null) ? null : sized.reduce((a, [, b]) => a + b, 0);
        const sizeLabel = measureSize ? fmtBytes(sum) : "未统计（--measure-size 可统计）";
        const list = sized.map(([t, b]) => measureSize ? `${t}(${fmtBytes(b)})` : t).join("、");
        if (!apply) {
          addPurgeBytes(sized);
          report("purge", rel, `可清构建产物 ${sizeLabel}：${list}`, branch);
        } else {
          // 整机占用扫描每棵树的删除阶段只做一次；逐目标仍刷新线程绑定。
          const purgeOccupants = computeOccupants();
          const failed = [];
          const removed = [];
          for (const entry of sized) {
            const [t] = entry;
            const blocked = snapshotReasons(dir, wtReal, snapshotDb(), purgeOccupants, []).reasons;
            const targetReason = purgeTargetReason(dir, t);
            if (blocked.length || targetReason) {
              report("skip", rel, `删除产物前复查发现阻断：${t}（${[...blocked, targetReason].filter(Boolean).join("；")}）`, branch);
              continue;
            }
            progress(`删除产物 ${rel}/${t}`);
            const started = performance.now();
            try {
              rmSync(join(dir, t), { recursive: true, maxRetries: 3, retryDelay: 300 });
            } catch {}
            progress(`删除产物结束 ${rel}/${t}（${Math.round(performance.now() - started)}ms）`);
            if (existsSync(join(dir, t))) failed.push(t);
            else removed.push(entry);
          }
          addPurgeBytes(removed);
          if (failed.length) report("failed", rel, `产物删除失败：${failed.join("、")}`, branch);
          if (removed.length) report("purged", rel, `已清构建产物${measureSize ? "" : "（未统计）"}：${removed.map(([t, b]) => measureSize ? `${t}(${fmtBytes(b)})` : t).join("、")}`, branch);
        }
      }
    }
    continue;
  }

  // ---- 全部条件满足 ----
  notes.push("干净"); // 推送状态文案由 gitStateReasons 按等价方式写进 notes
  if (!apply) {
    report("delete", rel, notes.join("；"), branch);
    continue;
  }

  // 删除前重拍复查（收窄 TOCTOU）：线程绑定/活跃 run/进程占用可能已变；
  // git 状态同样重查——扫描与执行之间后台进程可能新写 ignored 凭据或本地提交
  const reReasons = [
    ...snapshotReasons(dir, wtReal, snapshotDb(), computeOccupants(), []).reasons,
    ...gitStateReasons(dir, [], gitCommon, true),
  ];
  if (reReasons.length) {
    report("skip", rel, `删除前复查发现阻断：${reReasons.join("；")}`, branch);
    continue;
  }

  // 删除用 rmSync + worktree prune 而非 worktree remove：前者没有 spawn
  // 超时——数万 ignored 产物（SwiftPM .build 等）的递归 unlink 可能超过任何
  // 进程级超时上限，被砍在半途只会留下「tracked 全 D」的半删残留。
  // 脏树/未推送等兜底核验已在上面复查段完成；Windows 上文件占用会抛错
  // 走 failed，与「靠删除失败兜底」的既定策略一致。
  progress(`删除工作树 ${rel}`);
  const deleteStarted = performance.now();
  try {
    rmSync(dir, { recursive: true, maxRetries: 3, retryDelay: 300 });
  } catch {}
  if (existsSync(dir)) {
    report("failed", rel, "目录删除失败（占用或权限）", branch);
    continue;
  }
  progress(`删除工作树完成 ${rel}（${Math.round(performance.now() - deleteStarted)}ms）`);
  // 注销 worktree 注册项：dir 已消失，prune 直接清掉 admin 记录
  shErr("git", ["--git-dir", gitCommon, "worktree", "prune"]);
  if (branch) {
    const bd = shErr("git", ["--git-dir", gitCommon, "branch", "-d", branch]);
    if (bd.ok) notes.push(`分支 ${branch} 已删`);
    else if (forceDelOk.has(norm(dir))) {
      // 改动已验证在远端：-d 拒删只是没合入当前 HEAD，-D 强删让悬挂引用进 gc
      const bf = shErr("git", ["--git-dir", gitCommon, "branch", "-D", branch]);
      if (bf.ok) notes.push(`分支 ${branch} 已删（-D，改动已在远端）`);
      else notes.push(`分支 ${branch} 保留（${bf.err || "branch -D 失败"}）`);
    } else notes.push(`分支 ${branch} 保留（${bd.err || "branch -d 失败"}）`);
  }
  report("deleted", rel, notes.join("；"), branch);
}

// 收尾清扫：本轮删空的二层分组目录（如 musiver/ 下工作树删光后剩的空壳）
// 一并 rmdir。只动空目录——rmdirSync 对非空目录报错，天然兜底；调用者 cwd
// 与有进程 cwd 落在里面的跳过。
if (apply) {
  for (const g of subdirs(scanRoot)) {
    const gr = tryReal(g) ?? norm(g);
    if (inside(cwdReal, gr)) continue;
    let busy = false;
    if (occSnap)
      for (const p of occSnap.keys())
        if (inside(tryReal(p) ?? norm(p), gr)) {
          busy = true;
          break;
        }
    if (busy) continue;
    try {
      rmdirSync(g);
      report("deleted", relOf(g), "删空的分组目录", null);
    } catch {}
  }
}

// ---------- 输出 ----------
const total = rows.length;
console.log(
  `汇总：共 ${total} 个目录 — 可删 ${counts.delete} / 已删 ${counts.deleted} / skip ${counts.skip} / not-a-worktree ${counts["not-a-worktree"]} / failed ${counts.failed}`
);
if (purgeBuild) console.log(`构建产物：可清 ${counts.purge} / 已清 ${counts.purged}，${!measureSize ? "空间未统计" : purgeUnknown ? `已知 ${fmtBytes(purgeTotal)}，另有未知大小` : `共 ${fmtBytes(purgeTotal)}`}`);
console.log(`在用工作树（绑定线程未终结或有进行中 run）：${inUseDirs} 个`);
if (!apply && counts.delete + counts.purge > 0) console.log("（dry-run：加 --apply 执行删除）");
// 有 requested 删除失败时退出码非 0——自动化按退出码判清理成败
process.exit(counts.failed > 0 ? 1 : 0);
