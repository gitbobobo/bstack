#!/usr/bin/env node
// 真实 CLI 边界回放多分支超时；不读取真实 T3 数据，不等待真实 15 秒超时。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { before, after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const script = fileURLToPath(new URL('./t3-worktree-gc.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 't3gc-verify-'));
const home = join(root, 't3');
const repo = join(root, 'main');
const origin = join(root, 'origin.git');
const scan = join(home, 'worktrees');
const dirtyHead = join(scan, 'local-only');
const clean = join(scan, 'clean');
const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
before(() => {
  mkdirSync(scan, { recursive: true });
  mkdirSync(join(home, 'userdata'));
  git('init', '--bare', origin);
  git('init', '-b', 'main', repo);
  writeFileSync(join(repo, 'source.txt'), 'source\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-m', 'initial');
  git('-C', repo, 'remote', 'add', 'origin', origin);
  git('-C', repo, 'push', '-u', 'origin', 'main');
  git('-C', repo, 'worktree', 'add', '-b', 'local-only', dirtyHead);
  writeFileSync(join(dirtyHead, 'local.txt'), 'not delivered\n');
  git('-C', dirtyHead, 'add', '.');
  git('-C', dirtyHead, 'commit', '-m', 'local only');
  git('-C', repo, 'worktree', 'add', '-b', 'clean', clean);
  // 这些引用均不能证明本地独有提交已交付，模拟历史日志里的大量 origin 分支。
  const shipped = git('-C', repo, 'rev-parse', 'main');
  for (let i = 0; i < 18; i++) git('--git-dir', origin, 'update-ref', `refs/heads/topic-${i}`, shipped);
  const db = new DatabaseSync(join(home, 'userdata', 'statev2.sqlite'));
  db.exec(`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, title TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT, status TEXT);
    CREATE TABLE orchestration_v2_projection_subagents(child_thread_id TEXT, provider_thread_id TEXT, status TEXT);`);
  db.close();
});
after(() => {
  for (const tree of [dirtyHead, clean]) if (existsSync(tree)) git('-C', repo, 'worktree', 'remove', '--force', tree);
  // 保留小型主仓库、trace 和日志，失败时可复核；不递归删除临时目录。
});
let seq = 0;
function probe({ injection = '', args = [], target = dirtyHead } = {}) {
  const id = ++seq;
  const trace = join(root, `trace-${id}.jsonl`);
  const hook = join(root, `hook-${id}.mjs`);
  writeFileSync(hook, `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let clock = 0;
let virtual = false;
const realNow = performance.now.bind(performance);
Object.defineProperty(performance, 'now', {value: () => virtual ? clock : realNow(), configurable: true});
const original = cp.execFileSync;
cp.execFileSync = function(cmd, args, opts) {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({cmd, args, timeout: opts?.timeout}) + '\\n');
  ${injection}
  return original.call(this, cmd, args, opts);
};
syncBuiltinESMExports();`);
  const start = performance.now();
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, '--disposable', '--path', target, ...args], {
    cwd: root, env: { ...process.env, T3CODE_HOME: home }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const elapsedMs = performance.now() - start;
  writeFileSync(join(root, `run-${id}.log`), (r.stdout || '') + '\n' + (r.stderr || ''));
  const calls = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
  assert.equal(r.status, 0, r.stderr);
  return { ...r, calls, elapsedMs };
}

test('超时即止：大量远端分支也只尝试一次 cherry，不继续 diff/log', () => {
  const r = probe({ injection: `if (args.includes('cherry')) { const e = new Error('replay 15000ms timeout'); e.code = 'ETIMEDOUT'; e.signal = 'SIGTERM'; throw e; }` });
  assert.equal(r.calls.filter(c => c.args.includes('cherry')).length, 1);
  assert.ok(!r.calls.some(c => c.args.includes('diff') || c.args.includes('log')));
  assert.match(r.stdout, /^skip\s.*(?:超时|预算)/m);
  assert.ok(existsSync(dirtyHead));
});

test('交付验证范围：深度比较只查默认/跟踪分支，不遍历 topic refs', () => {
  const r = probe();
  const cherries = r.calls.filter(c => c.args.includes('cherry'));
  assert.equal(cherries.length, 1);
  assert.ok(cherries.every(c => c.args.includes('refs/remotes/origin/main')));
  assert.match(r.stdout, /^skip\s.*未推送/m);
  assert.ok(r.calls.filter(c => c.args.includes('diff')).length <= 1);
});

test('整次预算耗尽：命令成功但超过期限也不能放行，后续树不再联网', () => {
  const r = probe({ target: clean, args: ['--verify-budget-ms', '1000', '--path', dirtyHead], injection: `
if (args.includes('remote') && args.includes('get-url')) { virtual = true; clock = realNow(); }
if (args.includes('fetch')) { clock += 2000; return ''; }` });
  assert.equal(r.calls.filter(c => c.args.includes('fetch')).length, 1);
  assert.ok(!r.calls.some(c => c.args.includes('cherry')));
  assert.equal(r.stdout.split('\n').filter(l => /^skip\s/.test(l)).length, 2);
  assert.match(r.stdout, /预算/);
  assert.ok(r.calls.filter(c => c.args.includes('fetch')).every(c => c.timeout <= 1000));
});

test('同一棵树复查不重置预算：apply 时耗尽则保留目录', () => {
  const r = probe({ target: clean, args: ['--apply'], injection: `
if (args.includes('remote') && args.includes('get-url') && !virtual) { virtual = true; clock = realNow(); }
if (args.includes('fetch')) return '';
if (args.includes('--contains=HEAD')) clock += 3000;` });
  assert.match(r.stdout, /^skip\s.*删除前复查.*预算/m);
  assert.ok(!/^deleted\s/m.test(r.stdout));
  assert.ok(existsSync(clean));
});

test('fetch/祖先检查/patch 任一步超时都立即停止，不将未知当作已交付', () => {
  for (const stage of ['fetch', '--contains=HEAD', 'diff', 'log', 'patch-id']) {
    const r = probe({ injection: `if (args.includes(${JSON.stringify(stage)})) { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; }` });
    const index = r.calls.findIndex(c => c.args.includes(stage));
    assert.ok(index >= 0, stage);
    assert.ok(!r.calls.slice(index + 1).some(c => c.args.some(a => ['fetch', 'cherry', 'diff', 'log', 'patch-id', '--contains=HEAD'].includes(a))), stage);
    assert.match(r.stdout, /^skip\s.*超时/m);
    assert.ok(existsSync(dirtyHead));
  }
});

test('verify-budget-ms 拒绝空值、非正数和非整数', () => {
  for (const v of ['', '0', '-1', 'abc', '1.5']) {
    const r = spawnSync(process.execPath, [script, '--verify-budget-ms', v], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 2, v);
  }
});
