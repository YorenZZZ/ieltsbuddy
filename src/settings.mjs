import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { llmConfig, sttConfig } from './llm.mjs';
import { httpError } from './util.mjs';

// 服务设置：主 AI、语音转写 AI 与资料目录在设置页可改，未填的项回落到环境变量（.env）。
// 密钥只在服务端读取；接口只返回掩码，提交空密钥表示保持不变。
const urlFields = ['llmBaseUrl', 'sttBaseUrl'];
const keyFields = ['llmApiKey', 'sttApiKey'];
const textFields = ['llmModel', 'sttModel', 'libraryDir'];
const fields = [...urlFields, ...keyFields, ...textFields];

export function storedSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().filter((row) => fields.includes(row.key)).map((row) => [row.key, row.value]));
}

export function effectiveSettings(db, env = process.env) {
  const stored = storedSettings(db);
  return settingsFromValues(stored, env);
}

function settingsFromValues(stored, env) {
  const llm = llmConfig(env);
  const stt = sttConfig(env);
  const pick = (key, fallback) => stored[key] || fallback;
  return {
    llm: { baseUrl: pick('llmBaseUrl', llm.baseUrl).replace(/\/$/, ''), apiKey: pick('llmApiKey', llm.apiKey), model: pick('llmModel', llm.model) },
    stt: { baseUrl: pick('sttBaseUrl', stt.baseUrl).replace(/\/$/, ''), apiKey: pick('sttApiKey', stt.apiKey), model: pick('sttModel', stt.model) },
    libraryDir: pick('libraryDir', env.IELTS_LIBRARY_DIR || './library'),
  };
}

const mask = (key) => (!key ? '' : key.length <= 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`);

export function publicSettings(db, env = process.env) {
  const current = effectiveSettings(db, env);
  return {
    llm: { baseUrl: current.llm.baseUrl, model: current.llm.model, apiKeyMasked: mask(current.llm.apiKey), hasKey: Boolean(current.llm.apiKey) },
    stt: { baseUrl: current.stt.baseUrl, model: current.stt.model, apiKeyMasked: mask(current.stt.apiKey), hasKey: Boolean(current.stt.apiKey) },
    libraryDir: current.libraryDir,
  };
}

export function validateSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, '设置必须是对象');
  const changes = [];
  for (const key of fields) {
    if (!Object.hasOwn(patch, key)) continue;
    if (typeof patch[key] !== 'string') throw httpError(400, '设置值必须是文本');
    const value = patch[key].trim();
    if (value.length > 1000) throw httpError(400, '设置值过长');
    if (keyFields.includes(key) && !value) continue;
    if (value && urlFields.includes(key)) {
      let url;
      try { url = new URL(value); } catch { throw httpError(400, '接口地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw httpError(400, '接口地址需使用 HTTP(S)，不能包含账号、查询参数或片段');
    }
    if (value && /\s/.test(value) && key !== 'libraryDir') throw httpError(400, '接口、密钥与模型名不能包含空白');
    if (value && key === 'libraryDir') {
      if (!isAbsolute(value)) throw httpError(400, '资料目录要写容器内的绝对路径，例如 /library');
      let ok = false;
      try { ok = statSync(value).isDirectory(); } catch { ok = false; }
      if (!ok) throw httpError(400, '容器内找不到资料目录，请先在 Docker 映射宿主机目录');
    }
    changes.push([key, value]);
  }
  return changes;
}

export function candidateSettings(db, patch = {}, env = process.env) {
  return settingsFromValues({ ...storedSettings(db), ...Object.fromEntries(validateSettings(patch)) }, env);
}

export function saveSettings(db, patch = {}) {
  const changes = validateSettings(patch);
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of changes) upsert.run(key, value);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
