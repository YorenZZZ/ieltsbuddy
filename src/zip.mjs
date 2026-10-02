// 只读解析 zip 中央目录，支持 zip64 与 GBK 文件名；条目以流方式读出（stored 支持区间读取）。
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const gbk = new TextDecoder('gbk');

function decodeName(bytes, flags) {
  if (flags & 0x800) return Buffer.from(bytes).toString('utf8');
  try { return utf8.decode(bytes); } catch { return gbk.decode(bytes); }
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, position);
  return buffer;
}

export async function listZip(zipPath) {
  const handle = await open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = await readAt(handle, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    const locator = eocd - 20;
    if ((cdOffset === 0xffffffff || count === 0xffff) && locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
      const record = await readAt(handle, 56, Number(tail.readBigUInt64LE(locator + 8)));
      count = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    const cd = await readAt(handle, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; n += 1) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLength), flags);
      for (let e = p + 46 + nameLength, end = e + extraLength; e + 4 <= end;) {
        const id = cd.readUInt16LE(e);
        const length = cd.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (entrySize === 0xffffffff) { entrySize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) localOffset = Number(cd.readBigUInt64LE(q));
        }
        e += 4 + length;
      }
      if (!name.endsWith('/') && !name.startsWith('__MACOSX/')) entries.push({ name, method, flags, compressedSize, size: entrySize, localOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export async function findEntry(zipPath, name) {
  return (await listZip(zipPath)).find((entry) => entry.name === name) || null;
}

export async function openEntryStream(zipPath, entry) {
  if (entry.flags & 1) throw new Error('加密的压缩条目无法读取');
  const handle = await open(zipPath, 'r');
  let header;
  try { header = await readAt(handle, 30, entry.localOffset); } finally { await handle.close(); }
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('压缩条目头损坏');
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (!entry.compressedSize) return createReadStream(zipPath, { start, end: start - 1 });
  const raw = createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(createInflateRaw());
  throw new Error(`不支持的压缩方式（${entry.method}）`);
}

export async function readEntry(zipPath, entry) {
  const chunks = [];
  for await (const chunk of await openEntryStream(zipPath, entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
