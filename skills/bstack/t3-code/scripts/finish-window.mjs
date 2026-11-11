#!/usr/bin/env node
// 本机全环境共享的 FIFO 收尾窗口。只维护租约，不发送消息或操作进程。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function windowAction(path, action, thread, now = Date.now()) {
  if (!['request', 'status', 'release'].includes(action) || !thread) throw new Error('usage: finish-window.mjs request|status|release <thread-id>');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS queue (ticket INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), thread TEXT NOT NULL, ticket INTEGER NOT NULL, expires INTEGER NOT NULL);`);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM owner WHERE expires <= ?').run(now);
    db.prepare('DELETE FROM queue WHERE expires <= ?').run(now);
    if (action === 'release') {
      db.prepare('DELETE FROM owner WHERE thread = ?').run(thread);
      db.prepare('DELETE FROM queue WHERE thread = ?').run(thread);
    }
    let owner = db.prepare('SELECT * FROM owner').get();
    if (action === 'request' && owner?.thread !== thread) {
      // 幂等请求保留票号；排队存活期随本线程请求刷新。
      db.prepare(`INSERT INTO queue(thread, expires) VALUES (?, ?)
        ON CONFLICT(thread) DO UPDATE SET expires=excluded.expires`).run(thread, now + 3600000);
      const first = db.prepare('SELECT * FROM queue ORDER BY ticket LIMIT 1').get();
      if (!owner && first?.thread === thread) {
        db.prepare('INSERT INTO owner VALUES (1, ?, ?, ?)').run(thread, first.ticket, now + 3600000);
        db.prepare('DELETE FROM queue WHERE thread = ?').run(thread);
        owner = db.prepare('SELECT * FROM owner').get();
      }
    }
    const queue = db.prepare('SELECT * FROM queue ORDER BY ticket').all();
    db.exec('COMMIT');
    return { granted: owner?.thread === thread, owner: owner ?? null, queue, now };
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const path = join(homedir(), '.config', 'bstack', 'state', 'finish-window.sqlite');
    console.log(JSON.stringify(windowAction(path, process.argv[2], process.argv[3]), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
