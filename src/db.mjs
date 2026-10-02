import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY, title TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    -- 一切练习（刷题、模考分项、预测、精听）都是一条 task；answer_key 不下发前端。
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, skill TEXT NOT NULL, type TEXT NOT NULL, title TEXT,
      payload TEXT NOT NULL, answer_key TEXT, status TEXT NOT NULL DEFAULT 'open', answer TEXT, result TEXT,
      band REAL, mock_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, graded_at TEXT);
    CREATE INDEX IF NOT EXISTS tasks_by_time ON tasks(created_at);
    CREATE TABLE IF NOT EXISTS mocks (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'running', sections TEXT NOT NULL,
      overall REAL, started_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY, skill TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS daily_plans (
      date TEXT PRIMARY KEY, items TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS vocab (
      id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE COLLATE NOCASE, meaning TEXT, example TEXT, note TEXT,
      source TEXT, ease REAL NOT NULL DEFAULT 2.5, interval_days INTEGER NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS speaking_stories (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, story TEXT NOT NULL, analysis TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    -- container 非空表示该条目位于压缩包内（container = 压缩包相对路径，entry = 包内路径）。
    CREATE TABLE IF NOT EXISTS library_documents (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, kind TEXT, size INTEGER, mtime TEXT,
      container TEXT, entry TEXT, text_status TEXT NOT NULL DEFAULT 'pending', chars INTEGER DEFAULT 0,
      seen_at TEXT, indexed_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(doc_id UNINDEXED, chunk, tokenize = 'trigram');
    CREATE TABLE IF NOT EXISTS listening_items (
      id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, title TEXT, segments TEXT NOT NULL, source TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  migrate(db);
  return db;
}

// 早期骨架版本建过的表缺少后来新增的列；只补列，不删改已有数据。
const addedColumns = {
  conversations: ['updated_at TEXT'],
  vocab: ['example TEXT', 'note TEXT', 'reps INTEGER NOT NULL DEFAULT 0', 'lapses INTEGER NOT NULL DEFAULT 0', 'created_at TEXT'],
  speaking_stories: ['analysis TEXT', 'updated_at TEXT'],
  library_documents: ['container TEXT', 'entry TEXT', "text_status TEXT NOT NULL DEFAULT 'pending'", 'chars INTEGER DEFAULT 0', 'seen_at TEXT'],
};

function migrate(db) {
  for (const [table, definitions] of Object.entries(addedColumns)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const definition of definitions) {
      if (!existing.has(definition.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
}

export const parseJson = (text, fallback = null) => {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};
