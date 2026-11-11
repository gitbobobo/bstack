import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowAction } from './finish-window.mjs';
test('FIFO、幂等、释放隔离、固定到期与过期队列', () => {
  const root = mkdtempSync(join(tmpdir(), 'finish-window-'));
  const path = join(root, 'state.sqlite');
  const act = (a, t, now = 100) => windowAction(path, a, t, now);
  try {
    assert.equal(act('request', 'a').granted, true);
    const b = act('request', 'b').queue[0].ticket;
    assert.equal(act('request', 'b').queue[0].ticket, b);
    assert.equal(act('request', 'c').granted, false);
    assert.equal(act('release', 'b').owner.thread, 'a');
    act('request', 'b'); // b 重新申请排在 c 后
    act('release', 'a');
    assert.equal(act('request', 'b').granted, false);
    assert.equal(act('request', 'c').granted, true);
    assert.equal(act('request', 'c', 200).owner.expires, 3600100);
    assert.equal(act('request', 'd', 3600100).granted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('多个独立进程同时申请只有一个持有者', async () => {
  const { spawn } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'finish-window-race-'));
  const path = join(root, 'state.sqlite');
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const code = `import { windowAction } from ${JSON.stringify(new URL('./finish-window.mjs', import.meta.url).href)}; console.log(JSON.stringify(windowAction(${JSON.stringify(path)}, 'request', 'thread-${i}')));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
      let out = '', err = '';
      child.stdout.on('data', c => out += c);
      child.stderr.on('data', c => err += c);
      child.on('error', reject);
      child.on('close', s => s === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    })));
    assert.equal(results.filter(r => r.granted).length, 1);
    assert.equal(new Set(results.map(r => r.owner.thread)).size, 1);
    assert.equal(windowAction(path, 'status', 'observer').queue.length, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
