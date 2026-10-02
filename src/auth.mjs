import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

// 单用户登录：用户名 + scrypt 加盐哈希（configure.py 生成）+ HMAC 签名的会话 Cookie，做法与工作台一致。
export function authConfig(env = process.env) {
  const username = String(env.IELTSBUDDY_USERNAME || '').trim();
  const passwordHash = String(env.IELTSBUDDY_PASSWORD_HASH || '').trim();
  const secret = String(env.IELTSBUDDY_SESSION_SECRET || '');
  return { username, passwordHash, secret, enabled: Boolean(username && passwordHash && secret.length >= 32) };
}

const COOKIE = 'ieltsbuddy_session';
const SESSION_DAYS = 30;

// 哈希格式 scrypt:<salt>:<hex>（N=16384, r=8, p=1）。.env 里的 $ 会被 Compose 当变量替换，所以用冒号分隔；兼容工作台的 $ 写法。
export function validPassword(config, password) {
  const [scheme, salt, expectedHex] = config.passwordHash.split(/[:$]/);
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const supplied = scryptSync(String(password || ''), salt, expected.length);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// 会话里带上密码哈希的指纹：改密码后旧 Cookie 全部失效。
const fingerprint = (config) => createHash('sha256').update(config.passwordHash).digest('base64url').slice(0, 12);
const sign = (config, payload) => createHmac('sha256', config.secret).update(payload).digest('base64url');

export function sessionToken(config, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: config.username, v: fingerprint(config), exp: now + SESSION_DAYS * 86_400_000 })).toString('base64url');
  return `${payload}.${sign(config, payload)}`;
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

export function validSession(config, req, now = Date.now()) {
  if (!config.enabled) return false;
  const token = cookieValue(req, COOKIE);
  const separator = token.lastIndexOf('.');
  if (separator < 1) return false;
  const payload = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(config, payload));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.u === config.username && session.v === fingerprint(config) && Number(session.exp) > now;
  } catch {
    return false;
  }
}

const requestIsHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

export function sessionCookie(req, token, maxAgeSeconds = SESSION_DAYS * 86_400) {
  return [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? maxAgeSeconds : 0}`, requestIsHttps(req) ? 'Secure' : ''].filter(Boolean).join('; ');
}

// 经反向代理（NAS 上的 Lucky）进来的请求会带转发头；未设登录时据此拒绝外网访问。
export const viaProxy = (req) => Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);

// 只有对端是回环或本机网卡地址（Lucky 与 IeltsBuddy 同机、host 网络）时才采信 X-Real-IP / X-Forwarded-For；
// 局域网设备直连端口时这两个头可以伪造，不能用来绕过登录限流。
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

function normalizeAddress(value) {
  const text = String(value || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  const address = mapped ? mapped[1] : text;
  return isIP(address) ? address : '';
}

let ownCache = { at: 0, addresses: new Set() };
function ownAddresses() {
  if (Date.now() - ownCache.at < 60_000) return ownCache.addresses;
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) addresses.add(normalizeAddress(entry.address));
  addresses.delete('');
  ownCache = { at: Date.now(), addresses };
  return addresses;
}

function trustedProxy(address) {
  const family = isIP(address);
  if (family && loopback.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  return ownAddresses().has(address);
}

export function clientAddress(req) {
  const peer = normalizeAddress(req.socket.remoteAddress);
  if (!peer) return 'unknown';
  if (!trustedProxy(peer)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return normalizeAddress(req.headers['x-real-ip']) || normalizeAddress(forwarded) || peer;
}

// IPv6 客户端通常拿到整段 /64，逐地址计数等于不限，按 /64 归并。
export function rateLimitKey(address) {
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '').toLowerCase()).join(':')}::/64`;
}

// 每个来源 15 分钟内最多失败 5 次。表满时先清过期项，再挤掉一个未锁定的桶；全是锁定桶才拒绝新来源。
export function loginLimiter({ windowMs = 15 * 60_000, maxFailures = 5, limit = 5000 } = {}) {
  const buckets = new Map();
  const bucket = (key, now = Date.now()) => {
    if (buckets.size >= limit && !buckets.has(key)) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      if (buckets.size >= limit) for (const [k, b] of buckets) if (b.count < maxFailures) { buckets.delete(k); break; }
      if (buckets.size >= limit) return null;
    }
    const entry = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (entry.resetAt <= now) Object.assign(entry, { count: 0, resetAt: now + windowMs });
    buckets.set(key, entry);
    return entry;
  };
  return {
    blocked(key, now) { const b = bucket(key, now); return !b || b.count >= maxFailures; },
    fail(key, now) { const b = bucket(key, now); if (b) b.count += 1; },
    clear(key) { buckets.delete(key); },
  };
}
