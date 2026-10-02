import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { scanLibrary, indexPendingText, searchLibrary, chunkText, ftsQuery, resolveMediaFile } from '../src/library.mjs';
import { listZip, readEntry } from '../src/zip.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ib-lib-'));
  mkdirSync(join(root, '专项训练', '听力'), { recursive: true });
  writeFileSync(join(root, '专项训练', '听力', '场景词汇.txt'), 'Accommodation vocabulary: deposit, landlord, tenancy agreement. 听力场景词汇：住宿、押金。'.repeat(5));
  writeFileSync(join(root, 'ignore.xyz'), 'x');
  // 用 Python 生成含 deflate 与 stored 条目的 zip。
  execFileSync('python3', ['-c', `
import zipfile
with zipfile.ZipFile(${JSON.stringify(join(root, '音频.zip'))}, 'w') as z:
    z.writestr('Test 1/Section 1.mp3', b'ID3' + b'\\x00' * 2000, compress_type=zipfile.ZIP_STORED)
    z.writestr('Test 1/notes.txt', 'Lecture about urbanisation and green belts. ' * 20, compress_type=zipfile.ZIP_DEFLATED)
`]);
  return root;
}

test('zip 中央目录解析与条目读取', async () => {
  const root = fixture();
  const entries = await listZip(join(root, '音频.zip'));
  assert.deepEqual(entries.map((e) => e.name).sort(), ['Test 1/Section 1.mp3', 'Test 1/notes.txt']);
  const notes = await readEntry(join(root, '音频.zip'), entries.find((e) => e.name.endsWith('.txt')));
  assert.match(notes.toString(), /urbanisation/);
});

test('扫描登记文件与压缩包条目，抽取文字后可全文检索', async () => {
  const root = fixture();
  const db = openDatabase(':memory:');
  const { count } = await scanLibrary(db, root);
  assert.equal(count, 4); // txt + zip + 两个包内条目
  await indexPendingText(db, root, join(root, '.cache'));
  const statuses = Object.fromEntries(db.prepare('SELECT title, text_status FROM library_documents').all().map((r) => [r.title, r.text_status]));
  assert.equal(statuses['场景词汇'], 'ok');
  assert.equal(statuses.notes, 'ok');
  assert.equal(searchLibrary(db, 'tenancy agreement')[0].title, '场景词汇');
  assert.equal(searchLibrary(db, '听力场景词汇')[0].title, '场景词汇');
  assert.equal(searchLibrary(db, 'urbanisation green belts')[0].title, 'notes');
  // 再次扫描：未变化的文件保持已索引状态，删除的文件被移除。
  const again = await scanLibrary(db, root);
  assert.equal(again.removed, 0);
  assert.equal(db.prepare("SELECT text_status FROM library_documents WHERE title = '场景词汇'").get().text_status, 'ok');
});

test('压缩包内音频首次播放解出到缓存', async () => {
  const root = fixture();
  const db = openDatabase(':memory:');
  await scanLibrary(db, root);
  const doc = db.prepare("SELECT * FROM library_documents WHERE kind = 'audio'").get();
  const file = await resolveMediaFile(doc, root, join(root, '.cache'));
  assert.equal(readFileSync(file).subarray(0, 3).toString(), 'ID3');
  assert.equal(await resolveMediaFile(doc, root, join(root, '.cache')), file);
});

test('分块与检索词构造', () => {
  assert.equal(chunkText('a'.repeat(2000), 900, 100).length, 3);
  assert.equal(ftsQuery('听力场景'), '"听力场" OR "力场景"');
  assert.equal(ftsQuery('the and'), '');
});
