#!/usr/bin/env node
// t3-worktree-gc.test.mjs — t3-worktree-gc.mjs 的自包含夹具测试。
//
// 用法：node t3-worktree-gc.test.mjs（node:test 驱动，全部断言通过退出码 0）
//
// 在 fs.mkdtempSync 临时目录里构造：git 主仓库 + 假 origin（bare）、
// $T3CODE_HOME/worktrees/<组>/ 下若干 git worktree add 出的工作树、最小
// userdata/statev2.sqlite（node:sqlite 建，含 threads/runs/subagents 三表）。
// 全程不碰真实 ~/.t3：注入 T3CODE_HOME 与 --root。

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const req = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL("./t3-worktree-gc.mjs", import.meta.url));
const isWindows = platform() === "win32";

const tmp = mkdtempSync(join(tmpdir(), "t3gc-test-"));
const t3home = join(tmp, "t3home");
const wtRoot = join(t3home, "worktrees");
const group = join(wtRoot, "group");
const dbDir = join(t3home, "userdata");
const dbPath = join(dbDir, "statev2.sqlite");
const mainRepo = join(tmp, "main");
const origin = join(tmp, "origin.git");
const bareRepo = join(tmp, "bare.git"); // bare 主仓库：验证 --git-dir 删除路径

const D = {}; // 用例名 → 工作树路径
const sleepers = []; // 占用夹具进程，after() 统一 kill

const git = (argv) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...argv],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

// 跑 gc 脚本，返回 stdout。默认 cwd=tmp（位于任何工作树之外）。
function runGc(extra = [], { cwd = tmp, env = {} } = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...extra], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, T3CODE_HOME: t3home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
// 按目录名列匹配报告行：名字可能出现在别行 detail 里（如 br-wt-submod
// 被 squash 等价文案引用），须用 \s/// 边界隔开，不能裸 includes
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineFor = (out, name) =>
  out.split("\n").find((l) => new RegExp(`[\\s/]${escRe(name)}(?:\\s|$)`).test(l)) ?? "";
// git worktree list --porcelain 恒用 / 分隔；D.* 是本机分隔符，比较前先统一
const gpath = (p) => p.split(sep).join("/");

// ---------- 夹具 ----------
function insThread(db, { id, title = id, wt, settled = false, archived = null, deleted = null }) {
  const payload = { worktreePath: wt };
  if (settled) payload.settledOverride = "settled";
  db.prepare(
    `INSERT INTO orchestration_v2_projection_threads
     (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, deleted_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, "p1", title, "devin", "code", "default", "2026-01-01", "2026-01-01", archived, deleted, JSON.stringify(payload));
}
function insRun(db, { id, thread, status }) {
  db.prepare(
    `INSERT INTO orchestration_v2_projection_runs
     (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, thread, 1, "devin", status, "2026-01-01", "{}");
}
// 委派记录：thread_id=发起方线程，child_thread_id/provider_thread_id 指向
// 绑定工作树的子线程；status 终态白名单见被测脚本 SUBAGENT_TERMINAL
function insSubagent(db, { id, parent = "t-parent", child = null, providerThread = null, status }) {
  db.prepare(
    `INSERT INTO orchestration_v2_projection_subagents
     (subagent_id, thread_id, parent_node_id, provider, child_thread_id,
      provider_thread_id, origin, status, updated_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, parent, "n1", "devin", child, providerThread, "delegate_task", status, "2026-01-01", "{}");
}

before(() => {
  mkdirSync(group, { recursive: true });
  mkdirSync(dbDir, { recursive: true });

  // 主仓库 + 假 origin：push 后 fetch，让 refs/remotes/origin/* 存在
  git(["init", "--bare", origin]);
  git(["init", "-b", "main", mainRepo]);
  writeFileSync(join(mainRepo, "f.txt"), "x\n");
  // 根 .gitignore 进初始提交：夹具 ignored 文件不用额外提交，也不显脏
  writeFileSync(join(mainRepo, ".gitignore"), ".env\n*.db\n*.properties\n*.keystore\n*.log\nnode_modules/\ndist/\nbuild/\nlocal/\nsigning/\n.kube/\n.docker/\n*.tfstate*\nlocal.settings.json\nnested/\n.config/\n.build/\n.tmp/\nPods/\nCarthage/\nSourcePackages/\nDerivedData/\n.venv/\nvenv/\n__pycache__/\n.dart_tool/\nbower_components/\ncheckouts/\n");
  git(["-C", mainRepo, "add", "."]);
  git(["-C", mainRepo, "commit", "-m", "init"]);
  git(["-C", mainRepo, "remote", "add", "origin", origin]);
  git(["-C", mainRepo, "push", "-u", "origin", "main"]);
  git(["-C", mainRepo, "fetch", "origin"]);
  // 回归：status.showUntrackedFiles=no 配置下 untracked 文件不报 ??——
  // gc 必须靠 -uall 覆盖该配置，wt-dirty 检出即证明
  git(["-C", mainRepo, "config", "status.showUntrackedFiles", "no"]);

  const addWt = (name) => {
    const dir = join(group, name);
    git(["-C", mainRepo, "worktree", "add", "-b", `br-${name}`, dir]);
    return dir;
  };

  D.clean = addWt("wt-clean"); // 全条件满足 → 可删
  D.unbound = addWt("wt-unbound"); // 零绑定线程 → 可删（unbound）
  D.self = addWt("wt-self"); // self 用例：子进程 cwd 进去跑 → skip
  D.unsettled = addWt("wt-unsettled"); // 主线程未结算 → skip
  D.delegated = addWt("wt-delegated"); // 委派线程未结算且无 subagent 行 → skip
  D.deldone = addWt("wt-deldone"); // 委派线程未结算但 subagent 行已终态 → 可删
  D.delprov = addWt("wt-delprov"); // provider 子线程经 provider_thread_id 关联 → 可删
  D.delrun = addWt("wt-delrun"); // 委派线程有关联行但含非终态 → skip
  D.activerun = addWt("wt-activerun"); // 线程已结算但有 running run → skip
  D.dirty = addWt("wt-dirty"); // 未跟踪文件 → skip
  writeFileSync(join(D.dirty, "untracked.txt"), "x\n");
  D.unpushed = addWt("wt-unpushed"); // 本地孤立提交 → skip
  writeFileSync(join(D.unpushed, "wip.txt"), "x\n");
  git(["-C", D.unpushed, "add", "."]);
  git(["-C", D.unpushed, "commit", "-m", "wip"]);
  D.squash = addWt("wt-squash"); // 单提交 squash 合并：git cherry 逐提交 patch 等价 → 可删
  writeFileSync(join(D.squash, "sq.txt"), "sq\n");
  git(["-C", D.squash, "add", "."]);
  git(["-C", D.squash, "commit", "-m", "wip"]);
  D.squash2 = addWt("wt-squash2"); // 多提交被压成上游单提交：整支 diff patch-id 等价 → 可删
  writeFileSync(join(D.squash2, "m1.txt"), "m1\n");
  git(["-C", D.squash2, "add", "."]);
  git(["-C", D.squash2, "commit", "-m", "wip1"]);
  writeFileSync(join(D.squash2, "m2.txt"), "m2\n");
  git(["-C", D.squash2, "add", "."]);
  git(["-C", D.squash2, "commit", "-m", "wip2"]);
  // 等价提交落到 origin main：sq.txt 单独一个（对 wt-squash）、m1+m2 合一个
  // （对 wt-squash2 的合并 diff）。此时两工作树分支点仍是 init 提交
  writeFileSync(join(mainRepo, "sq.txt"), "sq\n");
  git(["-C", mainRepo, "add", "sq.txt"]);
  git(["-C", mainRepo, "commit", "-m", "wip (#11)"]);
  writeFileSync(join(mainRepo, "m1.txt"), "m1\n");
  writeFileSync(join(mainRepo, "m2.txt"), "m2\n");
  git(["-C", mainRepo, "add", "m1.txt", "m2.txt"]);
  git(["-C", mainRepo, "commit", "-m", "wip (#22)"]);
  git(["-C", mainRepo, "push", "origin", "main"]);
  D.occupied = addWt("wt-occupied"); // 进程占用但绑定线程全终结 → 残留进程降级放行
  D.occlive = addWt("wt-occlive"); // 进程占用 + 未终结线程 → skip
  D.occunbound = addWt("wt-occunbound"); // 进程占用但零绑定（占用无法归因）→ skip
  D.alias = addWt("wt-alias"); // 双路径拼写绑定，未终结别名线程须让它 skip
  D.precious = addWt("wt-precious"); // ignored 珍贵文件 → skip 并列出命中
  writeFileSync(join(D.precious, ".env"), "TOKEN=x\n");
  writeFileSync(join(D.precious, ".local.db"), "x\n");
  D.keystore = addWt("wt-keystore"); // local.properties/release.keystore 式凭据文件 → skip
  writeFileSync(join(D.keystore, "local.properties"), "release.storePassword=x\n");
  writeFileSync(join(D.keystore, "release.keystore"), "x\n");
  D.localsdk = addWt("wt-localsdk"); // local.properties 仅 sdk.dir → 内容豁免可删
  writeFileSync(join(D.localsdk, "local.properties"), "# generated by IDE\nsdk.dir=/opt/android-sdk\n");
  D.localmixed = addWt("wt-localmixed"); // 混入口令键 → 维持珍贵阻断
  writeFileSync(join(D.localmixed, "local.properties"), "sdk.dir=/opt/android-sdk\nstorePassword=x\n");
  D.artifacts = addWt("wt-artifacts"); // 只有 ignored 产物 → 可删（列名截断进报告）
  mkdirSync(join(D.artifacts, "node_modules"));
  writeFileSync(join(D.artifacts, "node_modules", "x.js"), "x\n");
  mkdirSync(join(D.artifacts, "dist"));
  writeFileSync(join(D.artifacts, "dist", "bundle.js"), "x\n");
  for (let i = 1; i <= 7; i++) writeFileSync(join(D.artifacts, `f${i}.log`), "x\n"); // 凑够 >8 项触发截断
  D.hiddendir = addWt("wt-hiddendir"); // ignored 目录里藏凭据：折叠视图看不到，须 ls-files 检出
  mkdirSync(join(D.hiddendir, "local"));
  writeFileSync(join(D.hiddendir, "local", ".env"), "TOKEN=x\n");
  mkdirSync(join(D.hiddendir, "signing"));
  writeFileSync(join(D.hiddendir, "signing", "app.keystore"), "x\n");
  D.classfiles = addWt("wt-classfiles"); // build/ 下的 *Credentials*.class：良性目录段过滤，不误拦
  mkdirSync(join(D.classfiles, "build", "intermediates"), { recursive: true });
  writeFileSync(join(D.classfiles, "build", "intermediates", "UpstreamBootstrapCredentials.class"), "x\n");
  D.buildnested = addWt("wt-buildnested"); // .build/checkouts 下的依赖检出是真实嵌套仓库，良性段豁免 → 可删
  git(["init", "-q", "-b", "main", join(D.buildnested, ".build", "checkouts", "PkgX")]);
  writeFileSync(join(D.buildnested, ".build", "checkouts", "PkgX", "x.txt"), "x\n");
  D.buildprecious = addWt("wt-buildprecious"); // .build 下凭据命名的构建产物（index store / build.db）→ 可删
  mkdirSync(join(D.buildprecious, ".build", "store"), { recursive: true });
  writeFileSync(join(D.buildprecious, ".build", "store", "NSURLCredential.h"), "x\n");
  writeFileSync(join(D.buildprecious, ".build", "build.db"), "x\n");
  D.clouddir = addWt("wt-clouddir"); // 标准云凭据位置：.kube/.docker/tfstate/azure → skip
  mkdirSync(join(D.clouddir, ".kube"));
  writeFileSync(join(D.clouddir, ".kube", "config"), "x\n");
  mkdirSync(join(D.clouddir, ".docker"));
  writeFileSync(join(D.clouddir, ".docker", "config.json"), "x\n");
  writeFileSync(join(D.clouddir, "terraform.tfstate"), "x\n");
  writeFileSync(join(D.clouddir, "local.settings.json"), "x\n");
  mkdirSync(join(D.clouddir, ".config", "gh"), { recursive: true }); // GH_CONFIG_DIR 项目本地凭据
  writeFileSync(join(D.clouddir, ".config", "gh", "hosts.yml"), "oauth_token: x\n");
  D.indexflags = addWt("wt-indexflags"); // 标记位隐藏本地修改：status 看不见，ls-files -v 检出
  writeFileSync(join(D.indexflags, "f.txt"), "edited\n");
  git(["-C", D.indexflags, "update-index", "--assume-unchanged", "f.txt"]);
  writeFileSync(join(D.indexflags, ".gitignore"), "edited\n");
  git(["-C", D.indexflags, "update-index", "--skip-worktree", ".gitignore"]);
  D.purge = addWt("wt-purge"); // 脏树保留，但 --purge-build 只删可重建产物（.build、.tmp 下的派生数据）
  writeFileSync(join(D.purge, "wip.txt"), "x\n");
  mkdirSync(join(D.purge, ".build", "debug"), { recursive: true });
  writeFileSync(join(D.purge, ".build", "debug", "a.o"), "x\n");
  mkdirSync(join(D.purge, ".tmp", "derived", "ModuleCache.noindex"), { recursive: true });
  writeFileSync(join(D.purge, ".tmp", "derived", "ModuleCache.noindex", "m"), "x\n");
  mkdirSync(join(D.purge, ".tmp", "notes"), { recursive: true });
  writeFileSync(join(D.purge, ".tmp", "notes", "keep.md"), "x\n");
  D.purgelive = addWt("wt-purgelive"); // 同样有产物但线程未终结 → 不清
  writeFileSync(join(D.purgelive, "wip.txt"), "x\n");
  mkdirSync(join(D.purgelive, ".build"), { recursive: true });
  writeFileSync(join(D.purgelive, ".build", "a.o"), "x\n");
  D.fsmon = addWt("wt-fsmon"); // fsmonitor 钩子谎报「无变更」：-c core.fsmonitor=false 退化回真实 stat
  const hook = join(tmp, "fsmon-hook.sh"); // v2 协议：回 token + 空变更列表
  writeFileSync(hook, '#!/bin/sh\nprintf "%s\\0" "$2"\n');
  chmodSync(hook, 0o755);
  git(["-C", D.fsmon, "config", "core.fsmonitor", hook]);
  git(["-C", D.fsmon, "status", "--porcelain"]); // 预热：建立 token、index 条目置 fsmonitor-valid
  writeFileSync(join(D.fsmon, "f.txt"), "edited\n");
  D.nested = addWt("wt-nested"); // ignored 目录本身是 git 仓库：ls-files 停在边界 → skip
  git(["init", "-q", "-b", "main", join(D.nested, "nested")]);
  writeFileSync(join(D.nested, "nested", ".env"), "TOKEN=x\n");
  D.baregit = addWt("wt-baregit"); // ignored 目录里的 bare 仓库：无 .git 边界被展开 → skip
  const bareDir = join(D.baregit, "local", "backup.git");
  git(["init", "--bare", "-q", bareDir]);
  git(["-C", mainRepo, "push", bareDir, "main"]); // 造未推送提交：objects/refs 非空
  D.staleref = addWt("wt-staleref"); // 远端分支已删但本地 tracking ref 残留 → fetch --prune 后判未推送 skip
  writeFileSync(join(D.staleref, "extra.txt"), "x\n");
  git(["-C", D.staleref, "add", "."]);
  git(["-C", D.staleref, "commit", "-m", "stale"]);
  git(["-C", D.staleref, "push", "origin", "HEAD:br-wt-staleref"]);
  git(["-C", mainRepo, "fetch", "origin"]); // 本地 origin/br-wt-staleref 就位
  git(["-C", mainRepo, "push", "origin", ":br-wt-staleref"]); // 远端删除（不加 --prune，本地跟踪引用残留）
  D.pushedelse = addWt("wt-pushedelse"); // 提交推上远端别的分支：已推送但未合入当前 HEAD，-d 拒删改走 -D → 可删
  writeFileSync(join(D.pushedelse, "pe.txt"), "pe\n");
  git(["-C", D.pushedelse, "add", "."]);
  git(["-C", D.pushedelse, "commit", "-m", "pushed elsewhere"]);
  git(["-C", D.pushedelse, "push", "origin", "HEAD:refs/heads/other-branch"]);
  git(["-C", mainRepo, "fetch", "origin"]); // refs/remotes/origin/other-branch 就位
  D.submod = addWt("wt-submod"); // 含 git 子模块：内部本地状态不可评估 → skip
  const subSrc = join(tmp, "subsrc");
  git(["init", "-b", "main", subSrc]);
  writeFileSync(join(subSrc, "s.txt"), "x\n");
  git(["-C", subSrc, "add", "."]);
  git(["-C", subSrc, "commit", "-m", "sub init"]);
  git(["-C", D.submod, "-c", "protocol.file.allow=always", "submodule", "add", subSrc, "vendor/sub"]);
  git(["-C", D.submod, "commit", "-m", "add submodule"]);
  git(["-C", D.submod, "push", "origin", "HEAD:br-wt-submod"]);
  git(["-C", D.submod, "fetch", "origin"]); // refs/remotes/origin/br-wt-submod 就位
  mkdirSync(join(group, "plain-dir")); // 空的非 git 目录 = 全白名单占位 → 可删
  // 占位残留：整树只有 T3 占位/系统垃圾文件 → 可删（绑定/占用检查照旧）
  D.placeholder = join(group, "wt-placeholder");
  mkdirSync(D.placeholder);
  writeFileSync(join(D.placeholder, ".keep"), "x\n");
  writeFileSync(join(D.placeholder, ".worktree-placeholder"), "x\n");
  writeFileSync(join(D.placeholder, ".DS_Store"), "x\n");
  D.phmixed = join(group, "wt-phmixed"); // 占位文件之外还有真实文件 → not-a-worktree
  mkdirSync(D.phmixed);
  writeFileSync(join(D.phmixed, ".keep"), "x\n");
  writeFileSync(join(D.phmixed, "real.txt"), "x\n");
  D.phbound = join(group, "wt-phbound"); // 占位目录但绑着未终结线程 → skip
  mkdirSync(D.phbound);
  writeFileSync(join(D.phbound, ".keep"), "x\n");
  // 二层分组目录：唯一子项是占位目录，--apply 删完子项后分组目录被清扫
  D.phgrp = join(wtRoot, "emptygrp", "wt-phgrp");
  mkdirSync(D.phgrp, { recursive: true });
  writeFileSync(join(D.phgrp, ".keep"), "x\n");
  git(["clone", mainRepo, join(group, "wt-clone")]); // 独立 clone → skip
  // gitfile 失效残留：.git 文件指向不存在的 admin 路径 → not-a-worktree
  D.stalegit = join(group, "wt-stalegit");
  mkdirSync(D.stalegit);
  writeFileSync(join(D.stalegit, ".git"), `gitdir: ${join(tmp, "gone-admin", "wt-stalegit")}\n`);

  // root 直接子目录本身是工作树（无分组层）的布局
  git(["-C", mainRepo, "worktree", "add", "-b", "br-wt-toplevel", join(wtRoot, "wt-toplevel")]);
  D.toplevel = join(wtRoot, "wt-toplevel");

  // bare 主仓库的工作树：--git-dir <gitCommon> 才能正确定位（dirname 推导会错）
  git(["init", "--bare", "-b", "main", bareRepo]);
  git(["-C", mainRepo, "push", bareRepo, "main"]);
  git(["--git-dir", bareRepo, "remote", "add", "origin", bareRepo]); // 自身做远端
  git(["--git-dir", bareRepo, "fetch", "origin"]); // 造出 refs/remotes/origin/*
  git(["--git-dir", bareRepo, "worktree", "add", "-b", "br-wt-bare", join(group, "wt-bare")]);
  D.bare = join(group, "wt-bare");

  // 最小 statev2.sqlite：只建 threads / runs 两表
  const { DatabaseSync } = req("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT)`);
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (
    run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    provider TEXT NOT NULL, provider_thread_id TEXT, status TEXT NOT NULL,
    requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT)`);
  db.exec(`CREATE TABLE orchestration_v2_projection_subagents (
    subagent_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT,
    parent_node_id TEXT NOT NULL, provider TEXT NOT NULL, provider_thread_id TEXT,
    child_thread_id TEXT, origin TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`);
  insThread(db, { id: "t-clean-1", wt: D.clean, settled: true });
  insThread(db, { id: "t-clean-2", wt: D.clean, archived: "2026-01-02" }); // archived 同样算终结
  insRun(db, { id: "r0", thread: "t-clean-1", status: "completed" }); // 已结束 run 不阻挡
  insThread(db, { id: "t-purge", wt: D.purge, settled: true });
  insThread(db, { id: "t-purgelive", title: "产物树线程未结算", wt: D.purgelive });
  insThread(db, { id: "t-unsettled", title: "主线程未结算", wt: D.unsettled });
  insThread(db, { id: "thread:delegated-task:test%3Ad1", title: "委派线程未结算", wt: D.delegated });
  insThread(db, { id: "thread:delegated-task:test%3Adone", title: "委派线程子代理已完结", wt: D.deldone });
  insSubagent(db, { id: "sa-done", child: "thread:delegated-task:test%3Adone", status: "completed" });
  insThread(db, { id: "thread:provider:acpRegistry:test%3Ap1", title: "provider子线程", wt: D.delprov });
  insSubagent(db, { id: "sa-prov", providerThread: "thread:provider:acpRegistry:test%3Ap1", status: "failed" });
  insThread(db, { id: "thread:delegated-task:test%3Adrun", title: "委派线程部分终态", wt: D.delrun });
  insSubagent(db, { id: "sa-run-1", child: "thread:delegated-task:test%3Adrun", status: "completed" });
  insSubagent(db, { id: "sa-run-2", child: "thread:delegated-task:test%3Adrun", status: "running" });
  insThread(db, { id: "t-activerun", title: "有活跃run", wt: D.activerun, settled: true });
  insRun(db, { id: "r1", thread: "t-activerun", status: "running" }); // 已终结线程上的 running = 投影滞留，放行
  insThread(db, { id: "t-occlive", title: "占用树的活线程", wt: D.occlive }); // 未终结：占用照常阻断
  insThread(db, { id: "t-phbound", title: "占位目录绑定线程", wt: D.phbound }); // 占位目录绑未终结线程仍 skip
  for (const [k, wt] of Object.entries({ self: D.self, dirty: D.dirty, unpushed: D.unpushed, squash: D.squash, squash2: D.squash2, occupied: D.occupied, toplevel: D.toplevel, bare: D.bare, precious: D.precious, keystore: D.keystore, localsdk: D.localsdk, localmixed: D.localmixed, artifacts: D.artifacts, hiddendir: D.hiddendir, classfiles: D.classfiles, buildnested: D.buildnested, buildprecious: D.buildprecious, clouddir: D.clouddir, indexflags: D.indexflags, nested: D.nested, baregit: D.baregit, staleref: D.staleref, pushedelse: D.pushedelse, submod: D.submod }))
    insThread(db, { id: `t-${k}`, wt, settled: true });
  // 同一工作树的两种路径拼写：realpath 别名下的未终结线程必须命中（别名合并回归）
  insThread(db, { id: "t-alias-1", wt: D.alias, settled: true });
  insThread(db, { id: "t-alias-2", title: "别名路径未终结线程", wt: realpathSync(D.alias) });
  db.close();

  // 进程占用夹具：sleep 的 cwd 落在被占用工作树里（POSIX）；时长留足跑完整个套件
  if (!isWindows)
    for (const d of [D.occupied, D.occlive, D.occunbound])
      sleepers.push(spawn("sleep", ["300"], { cwd: d, stdio: "ignore" }));
});

after(() => {
  for (const s of sleepers) s.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

// ---------- 用例 ----------
test("dry-run：逐目录判定，不删任何东西", () => {
  const out = runGc();
  assert.match(lineFor(out, "wt-clean"), /^delete\s/);
  assert.match(lineFor(out, "wt-unbound"), /^delete\s.*unbound/);
  assert.match(lineFor(out, "wt-toplevel"), /^delete\s/); // 无分组层布局也能识别
  assert.match(lineFor(out, "wt-self"), /^delete\s/); // 正常 cwd 下 self 树也可删
  assert.match(lineFor(out, "wt-bare"), /^delete\s/); // bare 主仓库的工作树也是链接工作树
  const preciousLine = lineFor(out, "wt-precious");
  assert.match(preciousLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(preciousLine, /\.env/);
  assert.match(preciousLine, /\.local\.db/);
  const keystoreLine = lineFor(out, "wt-keystore");
  assert.match(keystoreLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(keystoreLine, /local\.properties/);
  assert.match(keystoreLine, /release\.keystore/);
  // local.properties 内容豁免：仅 sdk.dir 的工具链生成文件放行；混入口令键维持阻断
  assert.match(lineFor(out, "wt-localsdk"), /^delete\s.*仅含 SDK 路径键已豁免（local\.properties）/);
  assert.match(lineFor(out, "wt-localmixed"), /^skip\s.*含珍贵忽略文件：local\.properties/);
  const artifactsLine = lineFor(out, "wt-artifacts");
  assert.match(artifactsLine, /^delete\s.*忽略文件 9 个（/); // 产物不珍贵，列名进报告
  assert.match(artifactsLine, /、…/); // 超 8 项截断出省略号
  const hiddendirLine = lineFor(out, "wt-hiddendir");
  assert.match(hiddendirLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(hiddendirLine, /local\/\.env/); // 折叠进 local/ 的凭据被逐文件检出
  assert.match(hiddendirLine, /signing\/app\.keystore/);
  assert.match(lineFor(out, "wt-classfiles"), /^delete\s.*忽略文件 1 个（build\/）/); // Credentials.class 经 build/ 段过滤
  assert.match(lineFor(out, "wt-buildnested"), /^delete\s/); // .build/checkouts 依赖检出经良性段豁免
  assert.match(lineFor(out, "wt-buildprecious"), /^delete\s/); // .build 下凭据命名产物经良性段豁免
  // squash 合并：单提交走 cherry 逐提交等价，多提交走整支 diff patch-id 等价
  assert.match(lineFor(out, "wt-squash"), /^delete\s.*等价/);
  assert.match(lineFor(out, "wt-squash2"), /^delete\s.*等价/);
  // 占位残留目录：全占位文件可删；绑未终结线程仍 skip；混入真实文件维持只报告
  assert.match(lineFor(out, "wt-placeholder"), /^delete\s.*占位目录/);
  assert.match(lineFor(out, "wt-phgrp"), /^delete\s.*占位目录/);
  assert.match(lineFor(out, "wt-phbound"), /^skip\s.*未终结.*占位目录绑定线程/);
  assert.match(lineFor(out, "wt-phmixed"), /^not-a-worktree/);
  const flagsLine = lineFor(out, "wt-indexflags"); // assume-unchanged/skip-worktree 标记 → skip
  assert.match(flagsLine, /^skip\s.*assume-unchanged\/skip-worktree 标记文件 2 个/);
  assert.match(flagsLine, /\.gitignore/);
  assert.match(flagsLine, /f\.txt/);
  // fsmonitor 钩子谎报无变更也挡不住：-c core.fsmonitor=false 退化真实 stat
  assert.match(lineFor(out, "wt-fsmon"), /^skip\s.*1 个未提交文件/);
  // 嵌套仓库内 .env 对 status/ls-files 都不可见，按不可枚举目录阻断
  assert.match(lineFor(out, "wt-nested"), /^skip\s.*嵌套仓库\/不可枚举目录：nested\//);
  // bare 嵌套仓库被 ls-files 展开成文件：按 HEAD+objects/config 特征阻断
  assert.match(lineFor(out, "wt-baregit"), /^skip\s.*嵌套仓库\/不可枚举目录：.*local\/backup\.git\//);
  // 远端删过 br-wt-staleref：本地残留 tracking ref 不代表已推送，fetch --prune 后仍判未推送
  assert.match(lineFor(out, "wt-staleref"), /^skip\s.*未推送/);
  // 子模块内部状态不可评估 → skip（其余条件均已满足）
  assert.match(lineFor(out, "wt-submod"), /^skip\s.*含 git 子模块.*1 个/);
  const cloudLine = lineFor(out, "wt-clouddir"); // 标准云凭据位置全部被珍贵模式拦住
  assert.match(cloudLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(cloudLine, /\.kube\/config/);
  assert.match(cloudLine, /\.docker\/config\.json/);
  assert.match(cloudLine, /terraform\.tfstate/);
  assert.match(cloudLine, /local\.settings\.json/);
  assert.match(cloudLine, /\.config\/gh\/hosts\.yml/);
  assert.match(lineFor(out, "wt-unsettled"), /^skip\s.*主线程 1 个未终结.*主线程未结算/);
  assert.match(lineFor(out, "wt-delegated"), /^skip\s.*委派线程 1 个未终结.*委派线程未结算/);
  // 委派子线程 settledOverride 永不写入：subagent 关联行全终态即放行
  assert.match(lineFor(out, "wt-deldone"), /^delete\s/);
  assert.match(lineFor(out, "wt-delprov"), /^delete\s/);
  // 关联行含非终态（running）仍按未终结阻塞
  assert.match(lineFor(out, "wt-delrun"), /^skip\s.*委派线程 1 个未终结.*委派线程部分终态/);
  // 已终结线程上的 running run 是投影滞留，降级为备注放行
  assert.match(lineFor(out, "wt-activerun"), /^delete\s.*残留 running 状态的 run 投影/);
  assert.match(lineFor(out, "wt-dirty"), /^skip\s.*1 个未提交文件/);
  assert.match(lineFor(out, "wt-unpushed"), /^skip\s.*未推送/);
  // 推上远端别的分支（未合入当前 HEAD）：祖先判定通过 → 可删
  assert.match(lineFor(out, "wt-pushedelse"), /^delete\s.*HEAD 已推送/);
  assert.match(lineFor(out, "wt-alias"), /^skip\s.*未终结.*别名路径未终结线程/);
  if (!isWindows) {
    // 占用降级：绑定线程全终结 → 判残留进程放行；活线程/零绑定占用仍阻断
    assert.match(lineFor(out, "wt-occupied"), /^delete\s.*残留进程/);
    assert.match(lineFor(out, "wt-occlive"), /^skip\s.*进程占用：pid \d+/);
    const occUnbound = lineFor(out, "wt-occunbound");
    assert.match(occUnbound, /^skip\s.*进程占用：pid \d+/);
    assert.doesNotMatch(occUnbound, /残留进程/);
  }
  assert.match(lineFor(out, "wt-clone"), /^skip\s.*独立 clone/);
  assert.match(lineFor(out, "plain-dir"), /^delete\s.*占位目录/); // 空目录视同为占位残留
  assert.match(lineFor(out, "wt-stalegit"), /^not-a-worktree/); // .git 失效文件不在白名单，维持只报告
  assert.match(out, /--apply 执行删除/);
  // 在用计数：wt-unsettled/wt-delegated/wt-delrun/wt-alias/wt-phbound/wt-occlive
  assert.match(out, /在用工作树（绑定线程未终结或有进行中 run）：7 个/);
  for (const d of Object.values(D)) assert.ok(existsSync(d), `dry-run 不应删除 ${d}`);
});

test("数据库缺席：根下所有工作树全部 skip", () => {
  const empty = mkdtempSync(join(tmpdir(), "t3gc-nodb-"));
  const out = runGc(["--root", wtRoot], { env: { T3CODE_HOME: empty } });
  for (const name of ["wt-clean", "wt-unbound", "wt-self", "wt-toplevel", "wt-bare", "wt-unsettled", "wt-delegated", "wt-deldone", "wt-delprov", "wt-delrun", "wt-activerun", "wt-dirty", "wt-unpushed", "wt-pushedelse", "wt-squash", "wt-squash2", "wt-occupied", "wt-occlive", "wt-occunbound", "wt-alias", "wt-precious", "wt-keystore", "wt-localsdk", "wt-localmixed", "wt-artifacts", "wt-hiddendir", "wt-classfiles", "wt-buildnested", "wt-buildprecious", "wt-clouddir", "wt-indexflags", "wt-fsmon", "wt-nested", "wt-baregit", "wt-staleref", "wt-submod", "wt-placeholder", "wt-phbound", "wt-phgrp", "plain-dir"])
    assert.match(lineFor(out, name), /^skip\s.*数据库缺席/, name);
  assert.equal(out.split("\n").filter((l) => l.startsWith("delete ")).length, 0, "DB 缺席时不得出现可删项");
  rmSync(empty, { recursive: true, force: true });
});

test("self：调用者 cwd 在工作树内时该树被跳过", { skip: isWindows && "POSIX 限定" }, () => {
  const out = runGc([], { cwd: D.self });
  assert.match(lineFor(out, "wt-self"), /^skip\s.*(self|位于此工作树内)/);
});

test("--root 缺值：报错退出而非静默回退 ~/.t3", () => {
  for (const argv of [["--root"], ["--apply", "--root"], ["--root", "--apply"], ["--root", ""], ["--root", "   "]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
      encoding: "utf8",
      cwd: tmp,
      env: { ...process.env, T3CODE_HOME: t3home },
    });
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, /--root 需要目录参数/);
  }
});

// 在真实 CLI 的 child_process 边界记录调用/模拟 du；不加生产环境测试开关。
function probeGc({ active = false, measure = false, apply = false, diagnose = false, target = ".build", mutation = null, duFail = false, posixOccupants = false } = {}) {
  const root = mkdtempSync(join(tmp, "probe-"));
  const wt = join(root, "tree");
  git(["-C", mainRepo, "worktree", "add", "--detach", wt]);
  writeFileSync(join(wt, "wip.txt"), "keep\n");
  mkdirSync(join(wt, target), { recursive: true });
  writeFileSync(join(wt, target, "a.o"), "artifact\n");
  if (target !== ".build") mkdirSync(join(wt, target, "ModuleCache.noindex"));
  if (posixOccupants) {
    mkdirSync(join(wt, "node_modules"));
    writeFileSync(join(wt, "node_modules", "a.js"), "artifact\n");
  }
  if (active) {
    const { DatabaseSync } = req("node:sqlite");
    const db = new DatabaseSync(dbPath);
    insThread(db, { id: root, wt });
    db.close();
  }
  const trace = join(root, "trace.jsonl");
  const hook = join(root, "hook.mjs");
  writeFileSync(hook, `
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
if (${posixOccupants}) os.platform = () => 'darwin';
const original = cp.execFileSync;
const artifactPath = ${JSON.stringify(join(wt, target))};
let mutated = false;
const record = (v) => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(v) + '\\n');
for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
  const write = stream.write.bind(stream);
  stream.write = (text, ...rest) => { record({stream: name, text: String(text)}); return write(text, ...rest); };
}
cp.execFileSync = function(cmd, args, opts) {
  record({cmd, args});
  if (${posixOccupants} && cmd === 'lsof') return '';
  if (cmd === 'du') {
    if (${duFail}) throw new Error('simulated du failure');
    return '8\\tartifact\\n';
  }
  if (!mutated && cmd === 'git' && args.includes('--cached')) {
    mutated = true;
    ${mutation || ""}
  }
  return original.call(this, cmd, args, opts);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, SCRIPT, "--root", root, "--purge-build", ...(measure ? ["--measure-size"] : []), ...(diagnose ? ["--diagnose"] : []), ...(apply ? ["--apply"] : [])], {
    cwd: tmp, encoding: "utf8", env: { ...process.env, T3CODE_HOME: t3home },
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { ...result, calls, wt };
}

test("purge 默认不运行 du，且输出阶段进度", () => {
  const r = probeGc();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c.cmd === "du").length, 0);
  assert.match(r.stdout, /^purge\s.*\.build/m);
  assert.match(r.stdout, /未统计/);
  assert.match(r.stderr, /进度.*tree/);
  assert.match(r.stderr, /ls-files/);
  const firstGit = r.calls.findIndex((c) => c.cmd === "git");
  const header = r.calls.findIndex((c) => c.stream === "stdout" && c.text.startsWith("扫描根："));
  assert.ok(header >= 0 && header < firstGit, "首次 git 调用前即输出扫描根");
  const fetch = r.calls.findIndex((c) => c.args?.includes("fetch"));
  assert.ok(fetch > 0);
  assert.match(r.calls[fetch - 1].text, /进度.*开始.*fetch/, "慢命令执行前即输出阶段信息");
  const report = r.calls.findIndex((c) => c.stream === "stdout" && c.text.startsWith("skip "));
  const discovery = r.calls.findIndex((c) => c.args?.includes("--directory"));
  assert.ok(report >= 0 && report < discovery, "先输出树的结论，再发现/统计产物");
});

test("默认 apply 同样跳过空间统计", () => {
  const r = probeGc({ apply: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.cmd === "du"));
  assert.match(r.stdout, /^purged\s.*未统计/m);
  assert.ok(!existsSync(join(r.wt, ".build")));
});

test("POSIX 占用扫描按树而非按产物执行，且开始前有日志", () => {
  const r = probeGc({ apply: true, posixOccupants: true });
  assert.equal(r.status, 0, r.stderr);
  const scans = r.calls.flatMap((c, i) => c.cmd === "lsof" ? [i] : []);
  assert.equal(scans.length, 2, "扫描期一次 + 该树删除阶段一次，不随目标数增加");
  for (const i of scans) assert.match(r.calls[i - 1].text, /进度.*开始 lsof/);
  assert.match(r.stdout, /^purged\s.*\.build.*node_modules/m);
});

test("--measure-size 单独使用拒绝执行", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--measure-size"], { encoding: "utf8", cwd: tmp });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--measure-size 需要 --purge-build/);
});

test("活跃树提前跳过 git 重检查", () => {
  const r = probeGc({ active: true, apply: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^skip\s.*未终结/m);
  assert.ok(!r.calls.some((c) => c.args?.some((a) => ["status", "ls-files", "fetch"].includes(a))));
  assert.ok(existsSync(join(r.wt, ".build", "a.o")));
});

test("诊断模式收集活跃树的 git 原因，但不清其产物", () => {
  const r = probeGc({ active: true, diagnose: true, apply: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^skip\s.*未终结.*未提交文件/m);
  assert.ok(r.calls.some((c) => c.args?.includes("status")));
  assert.ok(existsSync(join(r.wt, ".build", "a.o")));
});

test("显式统计成功显示大小", () => {
  const r = probeGc({ measure: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c.cmd === "du").length, 1);
  assert.match(r.stdout, /^purge\s.*\.build\(0M\)/m);
  assert.doesNotMatch(r.stdout, /未知|未统计/);
});

test("显式统计失败显示未知而非 0M，仍可清理", () => {
  const r = probeGc({ measure: true, apply: true, duFail: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some((c) => c.cmd === "du"));
  assert.match(r.stdout, /^purged\s.*未知/m);
  assert.ok(!existsSync(join(r.wt, ".build")));
});

test("purge 删除前阻断新增跟踪文件/非 ignored 文件/junction 越界（默认与统计模式）", () => {
  for (const measure of [false, true]) for (const [mutation, reason] of [
    [`original('git', ['-c', 'core.fsmonitor=false', '-C', artifactPath + '/..', 'add', '-f', '.build/a.o']);`, /目标含跟踪文件/],
    [`fs.writeFileSync(artifactPath + '/../.gitignore', '.build/*\\n!.build/a.o\\n');`, /目标含非 ignored 文件/],
    [`fs.writeFileSync(artifactPath + '/../.gitignore', '!/.build/\\n!/.build/**\\n');`, /目标含非 ignored 文件/],
    [`fs.renameSync(artifactPath, artifactPath + '-saved'); fs.symlinkSync(artifactPath + '-saved', artifactPath, ${JSON.stringify(isWindows ? "junction" : "dir")});`, /符号链接\/junction/],
  ]) {
    const r = probeGc({ measure, apply: true, mutation });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /删除产物前复查.*阻断/);
    assert.match(r.stdout, reason);
    assert.ok(existsSync(join(r.wt, ".build", "a.o")));
    if (mutation.includes("!.build/a.o")) {
      // 目录本身依然命中 ignore：仅靠 check-ignore 不能挡住此用例。
      git(["-c", "core.fsmonitor=false", "-C", r.wt, "check-ignore", "-q", ".build/"]);
    }
  }
});

test("purge 删除前重新确认产物标记", () => {
  const r = probeGc({ apply: true, target: ".tmp/derived", mutation: `fs.renameSync(artifactPath + '/ModuleCache.noindex', artifactPath + '/old-cache');` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /删除产物前复查.*不再符合构建产物规则/);
  assert.ok(existsSync(join(r.wt, ".tmp", "derived", "a.o")));
});

test("--apply：只删可删工作树并清理本地分支", () => {
  const out = runGc(["--apply"]);
  const deletable = ["wt-clean", "wt-unbound", "wt-self", "wt-toplevel", "wt-artifacts", "wt-classfiles", "wt-buildnested", "wt-buildprecious", "wt-squash", "wt-squash2", "wt-deldone", "wt-delprov", "wt-activerun", "wt-localsdk", "wt-occupied", "wt-pushedelse"];
  if (isWindows) deletable.push("wt-occunbound"); // Windows 不做占用检查，零绑定占用树会被删
  for (const name of deletable) {
    assert.match(lineFor(out, name), /^deleted\s/, name);
    assert.ok(!existsSync(D[name.slice(3)]), `${name} 目录应已消失`);
    assert.equal(git(["-C", mainRepo, "branch", "--list", `br-${name}`]), "", `br-${name} 应已删除`);
  }
  // bare 主仓库的工作树同样可删（验证 --git-dir 路径），且 br-wt-bare 被清理
  assert.match(lineFor(out, "wt-bare"), /^deleted\s/);
  assert.ok(!existsSync(D.bare));
  assert.equal(git(["--git-dir", bareRepo, "branch", "--list", "br-wt-bare"]), "", "br-wt-bare 应已删除");
  assert.ok(!git(["--git-dir", bareRepo, "worktree", "list", "--porcelain"]).includes(gpath(D.bare)));
  // git worktree 注册同步移除
  const list = git(["-C", mainRepo, "worktree", "list", "--porcelain"]);
  for (const d of [D.clean, D.unbound, D.self, D.toplevel, D.artifacts, D.classfiles]) assert.ok(!list.includes(gpath(d)), `${d} 不应再注册`);
  const kept = [D.unsettled, D.delegated, D.delrun, D.dirty, D.unpushed, D.alias, D.precious, D.keystore, D.localmixed, D.occlive, D.hiddendir, D.clouddir, D.indexflags, D.nested, D.baregit, D.staleref, D.submod];
  if (!isWindows) kept.push(D.occunbound); // POSIX 下零绑定占用仍阻断；Windows 不查占用会被删
  for (const d of kept) assert.ok(list.includes(gpath(d)), `${d} 应仍在注册表`);
  // skip 的工作树全部保留
  for (const d of kept) assert.ok(existsSync(d), `${d} 应保留`);
  assert.ok(!existsSync(join(group, "plain-dir")), "空占位目录应已删除");
  assert.ok(existsSync(join(group, "wt-clone")));
  assert.ok(existsSync(D.stalegit));
  // 占位目录被删；绑着未终结线程的占位目录与混入真实文件的目录保留
  assert.match(lineFor(out, "wt-placeholder"), /^deleted\s/);
  assert.ok(!existsSync(D.placeholder));
  assert.match(lineFor(out, "wt-phgrp"), /^deleted\s/);
  assert.ok(!existsSync(D.phgrp));
  assert.ok(!existsSync(join(wtRoot, "emptygrp")), "删空的分组目录应被清扫");
  assert.ok(existsSync(D.phbound), "绑定未终结线程的占位目录应保留");
  assert.ok(existsSync(D.phmixed), "混入真实文件的目录应保留");
  assert.ok(!/^failed/m.test(out), "不应有 failed");
});

test("--purge-build：只清已终结线程脏树里的可重建产物，保留跟踪/未提交/其他 ignored 内容", () => {
  const dry = runGc(["--purge-build"]);
  assert.match(dry, /^purge\s+group\/wt-purge\s.*\.build.*\.tmp\/derived/m);
  assert.doesNotMatch(dry, /^purge\s+group\/wt-purgelive/m);
  assert.ok(existsSync(join(D.purge, ".build")), "dry-run 不删");
  const out = runGc(["--purge-build", "--apply"], { env: {} });
  assert.match(out, /^purged\s+group\/wt-purge\s/m);
  assert.ok(!existsSync(join(D.purge, ".build")));
  assert.ok(!existsSync(join(D.purge, ".tmp", "derived")));
  assert.ok(existsSync(join(D.purge, ".tmp", "notes", "keep.md")), "非产物 ignored 文件保留");
  assert.ok(existsSync(join(D.purge, "wip.txt")), "未提交文件保留");
  assert.ok(existsSync(join(D.purgelive, ".build")), "未终结线程的树不清");
});
