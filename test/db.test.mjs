import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';

test('骨架版本数据库自动补列且保留原有数据', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ib-db-')), 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE vocab (id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE, meaning TEXT, source TEXT, ease REAL DEFAULT 2.5, interval_days INTEGER DEFAULT 0, due_at TEXT DEFAULT CURRENT_DATE, reviews INTEGER DEFAULT 0);
    CREATE TABLE speaking_stories (id INTEGER PRIMARY KEY, title TEXT NOT NULL, story TEXT NOT NULL, topics TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE library_documents (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, kind TEXT, size INTEGER, mtime TEXT, indexed_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO conversations (title) VALUES ('hi');
    INSERT INTO messages (conversation_id, role, content) VALUES (1, 'user', 'hi');
    INSERT INTO vocab (word) VALUES ('mitigate');
  `);
  old.close();
  const db = openDatabase(path);
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(columns('library_documents').includes('text_status'));
  assert.ok(columns('vocab').includes('lapses'));
  assert.ok(columns('conversations').includes('updated_at'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(db.prepare('SELECT reps FROM vocab').get().reps, 0);
  openDatabase(path); // 再次打开不重复加列
});
