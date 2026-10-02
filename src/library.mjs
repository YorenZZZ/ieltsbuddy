// NAS 雅思资料库：扫描只读目录（含压缩包内条目），抽取文字建 FTS 全文索引，供老师检索引用。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { listZip, openEntryStream, readEntry, findEntry } from './zip.mjs';

const run = promisify(execFile);
const kinds = {
  '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc', '.txt': 'text', '.md': 'text', '.lrc': 'text', '.srt': 'text',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.aac': 'audio', '.ogg': 'audio', '.flac': 'audio', '.wma': 'audio',
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.zip': 'zip',
};
const textKinds = new Set(['pdf', 'docx', 'text']);
const mediaTypes = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const maxTextSourceBytes = 400 * 1024 * 1024;

export const kindOf = (name) => kinds[extname(name).toLowerCase()] || null;
export const mediaTypeOf = (name) => mediaTypes[extname(name).toLowerCase()] || 'application/octet-stream';

export const libraryState = { running: false, phase: 'idle', done: 0, total: 0, message: '', finishedAt: null };

export async function scanLibrary(db, root) {
  const stamp = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO library_documents (path, title, kind, size, mtime, container, entry, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET title = excluded.title, kind = excluded.kind, seen_at = excluded.seen_at,
      text_status = CASE WHEN library_documents.size IS excluded.size AND library_documents.mtime IS excluded.mtime THEN library_documents.text_status ELSE 'pending' END,
      size = excluded.size, mtime = excluded.mtime`);
  let count = 0;
  const walk = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name.startsWith('@')) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) { await walk(full); continue; }
      const kind = kindOf(item.name);
      if (!kind) continue;
      const info = await stat(full);
      const rel = relative(root, full);
      upsert.run(rel, basename(item.name, extname(item.name)), kind, info.size, info.mtime.toISOString(), null, null, stamp);
      count += 1;
      if (kind !== 'zip') continue;
      try {
        for (const entry of await listZip(full)) {
          const entryKind = kindOf(entry.name);
          if (!entryKind || entryKind === 'zip') continue;
          upsert.run(`${rel}::${entry.name}`, basename(entry.name, extname(entry.name)), entryKind, entry.size, info.mtime.toISOString(), rel, entry.name, stamp);
          count += 1;
        }
      } catch (error) {
        console.warn(`跳过压缩包 ${rel}：${error.message}`);
      }
    }
  };
  await walk(root);
  const gone = db.prepare('SELECT id FROM library_documents WHERE seen_at IS NOT ? OR seen_at IS NULL').all(stamp);
  for (const { id } of gone) {
    db.prepare('DELETE FROM library_fts WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM library_documents WHERE id = ?').run(id);
  }
  return { count, removed: gone.length };
}

async function withLocalFile(doc, root, cacheDir, work) {
  if (!doc.container) return work(join(root, doc.path));
  const temp = join(cacheDir, 'tmp', `${doc.id}${extname(doc.entry)}`);
  mkdirSync(join(cacheDir, 'tmp'), { recursive: true });
  const entry = await findEntry(join(root, doc.container), doc.entry);
  if (!entry) throw new Error('压缩包内找不到该条目');
  await pipeline(await openEntryStream(join(root, doc.container), entry), createWriteStream(temp));
  try { return await work(temp); } finally { await rm(temp, { force: true }); }
}

async function extractText(doc, root, cacheDir) {
  if (doc.kind === 'text') {
    if (doc.container) {
      const zipPath = join(root, doc.container);
      return (await readEntry(zipPath, await findEntry(zipPath, doc.entry))).toString('utf8');
    }
    return readFile(join(root, doc.path), 'utf8');
  }
  return withLocalFile(doc, root, cacheDir, async (file) => {
    if (doc.kind === 'pdf') {
      const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', '-q', file, '-'], { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 });
      return stdout;
    }
    const xml = await readEntry(file, await findEntry(file, 'word/document.xml'));
    return xml.toString('utf8').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  });
}

export function chunkText(text, size = 900, overlap = 120) {
  const clean = String(text).replace(/\f/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    chunks.push(clean.slice(start, start + size));
    if (start + size >= clean.length) break;
  }
  return chunks;
}

export async function indexPendingText(db, root, cacheDir, onProgress = () => {}) {
  const pending = db.prepare(`SELECT * FROM library_documents WHERE text_status = 'pending' AND kind IN ('pdf','docx','text','doc') ORDER BY size`).all();
  let done = 0;
  for (const doc of pending) {
    onProgress(done, pending.length, doc.title);
    let status = 'ok';
    let chars = 0;
    db.prepare('DELETE FROM library_fts WHERE doc_id = ?').run(doc.id);
    if (!textKinds.has(doc.kind)) status = 'unsupported';
    else if (doc.size > maxTextSourceBytes) status = 'skipped';
    else {
      try {
        const chunks = chunkText(await extractText(doc, root, cacheDir));
        chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        // 扫描版 PDF 没有文字层，每页只剩空白与页码。
        if (chars < 200) status = 'empty';
        else {
          const insert = db.prepare('INSERT INTO library_fts (doc_id, chunk) VALUES (?, ?)');
          db.exec('BEGIN');
          for (const chunk of chunks) insert.run(doc.id, chunk);
          db.exec('COMMIT');
        }
      } catch (error) {
        status = 'error';
        console.warn(`抽取文字失败 ${doc.path}：${error.message}`);
      }
    }
    db.prepare('UPDATE library_documents SET text_status = ?, chars = ?, indexed_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, chars, doc.id);
    done += 1;
  }
  onProgress(done, pending.length, '');
  return done;
}

export async function refreshLibrary(db, root, cacheDir) {
  if (libraryState.running) return libraryState;
  Object.assign(libraryState, { running: true, phase: 'scan', done: 0, total: 0, message: '扫描目录…' });
  (async () => {
    try {
      const { count, removed } = await scanLibrary(db, root);
      libraryState.phase = 'index';
      await indexPendingText(db, root, cacheDir, (done, total, title) => Object.assign(libraryState, { done, total, message: title ? `抽取文字：${title}` : '' }));
      libraryState.message = `完成：登记 ${count} 项，移除 ${removed} 项`;
    } catch (error) {
      libraryState.message = `失败：${error.message}`;
    } finally {
      Object.assign(libraryState, { running: false, phase: 'idle', finishedAt: new Date().toISOString() });
    }
  })();
  return libraryState;
}

const stopWords = new Set('the and for with that this what how why you your are can about from have will should please'.split(' '));

export function ftsQuery(text) {
  const terms = new Set();
  for (const word of String(text).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) if (!stopWords.has(word)) terms.add(word);
  for (const segment of String(text).match(/[一-鿿]{3,}/g) || []) {
    for (let i = 0; i + 3 <= segment.length; i += 1) terms.add(segment.slice(i, i + 3));
  }
  return [...terms].slice(0, 32).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

export function searchLibrary(db, text, limit = 8) {
  const query = ftsQuery(text);
  const rows = query
    ? db.prepare(`SELECT f.doc_id AS docId, d.title, d.path, snippet(library_fts, 1, '【', '】', '…', 24) AS snippet, f.chunk
        FROM library_fts f JOIN library_documents d ON d.id = f.doc_id WHERE library_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit)
    : [];
  // 两字中文词无法走 trigram，按标题补充匹配。
  const short = String(text).match(/[一-鿿]{2}/g) || [];
  if (rows.length < limit && short.length) {
    for (const doc of db.prepare('SELECT id AS docId, title, path FROM library_documents WHERE title LIKE ? LIMIT ?').all(`%${short[0]}%`, limit - rows.length)) {
      if (!rows.some((row) => row.docId === doc.docId)) rows.push({ ...doc, snippet: '', chunk: '' });
    }
  }
  return rows;
}

// 压缩包内的媒体首次播放时解出到缓存，之后按普通文件支持区间请求（拖动进度、按句重听）。
export async function resolveMediaFile(doc, root, cacheDir) {
  if (!doc.container) return join(root, doc.path);
  const target = join(cacheDir, 'media', `${doc.id}${extname(doc.entry).toLowerCase()}`);
  if (existsSync(target) && statSync(target).size === doc.size) return target;
  mkdirSync(join(cacheDir, 'media'), { recursive: true });
  const zipPath = join(root, doc.container);
  const entry = await findEntry(zipPath, doc.entry);
  if (!entry) throw new Error('压缩包内找不到该条目');
  const partial = `${target}.part`;
  await pipeline(await openEntryStream(zipPath, entry), createWriteStream(partial));
  await rename(partial, target);
  return target;
}

// 语音转写前统一转成单声道 32kbps mp3，30 分钟约 7MB，低于接口 25MB 上限。
export async function audioForTranscription(file, cacheDir, id) {
  const target = join(cacheDir, 'stt', `${id}.mp3`);
  if (existsSync(target)) return readFile(target);
  mkdirSync(join(cacheDir, 'stt'), { recursive: true });
  await run('ffmpeg', ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', target], { timeout: 10 * 60_000 });
  return readFile(target);
}
