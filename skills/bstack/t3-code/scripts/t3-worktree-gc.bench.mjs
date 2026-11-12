#!/usr/bin/env node
// 隔离基准：node t3-worktree-gc.bench.mjs --baseline <旧脚本绝对路径>
// 可选 --runs 3 --trees 3 --files 4000 --output <JSON路径>；保留夹具和日志供复核。
// 对比同量工作树：单次 dry-run，以及旧 dry-run+apply / 新直接 apply。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const opts = { runs: 3, trees: 3, files: 4000 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!['baseline', 'output', 'runs', 'trees', 'files'].includes(key) || !process.argv[i + 1]) throw new Error('参数错误');
  opts[key] = ['runs', 'trees', 'files'].includes(key) ? Number(process.argv[i + 1]) : resolve(process.argv[i + 1]);
}
assert.ok(opts.baseline, '需要 --baseline');
for (const key of ['runs', 'trees', 'files']) assert.ok(Number.isInteger(opts[key]) && opts[key] > 0);
const current = fileURLToPath(new URL('./t3-worktree-gc.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 't3gc-bench-'));
const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(label) {
  const dir = join(root, label);
  const home = join(dir, 't3');
  const repo = join(dir, 'main');
  const origin = join(dir, 'origin.git');
  const scan = join(home, 'worktrees');
  mkdirSync(scan, { recursive: true });
  mkdirSync(join(home, 'userdata'));
  git('init', '--bare', origin);
  git('init', '-b', 'main', repo);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  for (let i = 0; i < 50; i++) writeFileSync(join(repo, `source-${i}.txt`), 'tracked\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-m', 'fixture');
  git('-C', repo, 'remote', 'add', 'origin', origin);
  git('-C', repo, 'push', '-u', 'origin', 'main');
  const db = new DatabaseSync(join(home, 'userdata', 'statev2.sqlite'));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (child_thread_id TEXT, provider_thread_id TEXT, status TEXT);`);
  const targets = [];
  const head = git('-C', repo, 'rev-parse', 'HEAD');
  for (let i = 0; i < opts.trees; i++) {
    const wt = join(scan, `tree-${i}`);
    git('-C', repo, 'worktree', 'add', '-b', `bench-${i}`, wt);
    targets.push(wt);
    const deps = join(wt, 'node_modules');
    mkdirSync(deps);
    for (let j = 0; j < opts.files; j++) {
      const pkg = join(deps, `pkg-${Math.floor(j / 100)}`);
      if (j % 100 === 0) mkdirSync(pkg);
      writeFileSync(join(pkg, `file-${j}.js`), 'export default 1;\n');
    }
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?)').run(`thread-${i}`, 'bench', JSON.stringify({ worktreePath: wt, settledOverride: 'settled' }), null, null);
  }
  db.close();
  return { home, scan, dir, targets, head };
}
function run(script, args, f, label, expected = opts.trees) {
  const start = performance.now();
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, T3CODE_HOME: f.home }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = performance.now() - start;
  writeFileSync(join(f.dir, `${label}.log`), r.stdout + '\n' + r.stderr);
  assert.equal(r.status, 0, r.stderr);
  const verdict = args.includes('--apply') ? 'deleted' : 'delete';
  assert.equal(r.stdout.split('\n').filter(l => l.startsWith(verdict + ' ')).length, expected, r.stdout);
  return ms;
}
const results = [];
const modes = ['baseline', 'fast', 'delivered'];
for (let i = 0; i < opts.runs; i++) {
  // 独立夹具，同量文件；交替顺序减少系统负载/缓存顺序偏差。
  for (const mode of [...modes.slice(i % modes.length), ...modes.slice(0, i % modes.length)]) {
    const f = fixture(`${i}-${mode}`);
    const script = mode === 'baseline' ? opts.baseline : current;
    const args = ['--root', f.scan, ...(mode === 'fast' ? ['--disposable'] : [])];
    let dryMs = 0;
    let applyMs = 0;
    if (mode === 'delivered') {
      for (const [j, target] of f.targets.entries()) {
        const targeted = ['--disposable', '--path', target, '--delivered-head', f.head];
        dryMs += run(script, targeted, f, `dry-${j}`, 1);
        applyMs += run(script, [...targeted, '--apply'], f, `apply-${j}`, 1);
      }
    } else {
      dryMs = run(script, args, f, 'dry');
      applyMs = run(script, [...args, '--apply'], f, 'apply');
    }
    results.push({ sample: i + 1, mode, dryMs, applyMs, workflowMs: mode === 'baseline' ? dryMs + applyMs : applyMs });
    console.error(`${mode} #${i + 1}: dry=${dryMs.toFixed(0)}ms apply=${applyMs.toFixed(0)}ms`);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(['dryMs', 'applyMs', 'workflowMs'].map(k => [k, median(results.filter(r => r.mode === mode).map(r => r[k]))]))]));
const report = { node: process.version, platform: process.platform, root, options: opts, description: '相同工作树/文件；本地 bare origin，无网络延迟。夹具创建不计时。fast/delivered dry 用于对比扫描，不计入新工作流耗时；delivered 对每棵树单独启动进程，仍删除同量文件。', results, summary };
const output = opts.output || join(root, 'result.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, ...report }, null, 2));
