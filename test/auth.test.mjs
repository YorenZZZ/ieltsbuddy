import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { scryptSync } from 'node:crypto';
import { authConfig, clientAddress, loginLimiter, rateLimitKey, sessionCookie, sessionToken, validPassword, validSession } from '../src/auth.mjs';
import { sttConfig, transcribe } from '../src/llm.mjs';
import { speakingPace } from '../src/practice.mjs';

const secret = 'x'.repeat(40);
const hashFor = (password, salt = 'a1b2c3d4', sep = ':') => ['scrypt', salt, scryptSync(password, salt, 64).toString('hex')].join(sep);
const requestWith = (cookie, extra = {}) => ({ headers: { cookie, ...extra }, socket: { remoteAddress: '192.0.2.50' } });

test('configure.py 生成的 scrypt 哈希能被服务端校验', () => {
  const script = "import configure; print(configure.hash_password('correct horse battery'))";
  const hash = execFileSync('python3', ['-B', '-c', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
  assert.match(hash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  const config = authConfig({ IELTSBUDDY_USERNAME: 'learner', IELTSBUDDY_PASSWORD_HASH: hash, IELTSBUDDY_SESSION_SECRET: secret });
  assert.equal(config.enabled, true);
  assert.equal(validPassword(config, 'correct horse battery'), true);
  assert.equal(validPassword(config, 'correct horse batter'), false);
});

test('兼容工作台 $ 分隔的哈希；缺任一项不开启登录', () => {
  const config = authConfig({ IELTSBUDDY_USERNAME: 'learner', IELTSBUDDY_PASSWORD_HASH: hashFor('pw-123456789', 'salt', '$'), IELTSBUDDY_SESSION_SECRET: secret });
  assert.equal(validPassword(config, 'pw-123456789'), true);
  assert.equal(authConfig({ IELTSBUDDY_USERNAME: 'learner', IELTSBUDDY_PASSWORD_HASH: hashFor('p'), IELTSBUDDY_SESSION_SECRET: 'short' }).enabled, false);
  assert.equal(authConfig({ IELTSBUDDY_PASSWORD_HASH: hashFor('p'), IELTSBUDDY_SESSION_SECRET: secret }).enabled, false);
});

test('会话 Cookie：签名、过期、改密码与篡改都会失效', () => {
  const config = authConfig({ IELTSBUDDY_USERNAME: 'learner', IELTSBUDDY_PASSWORD_HASH: hashFor('pw-123456789'), IELTSBUDDY_SESSION_SECRET: secret });
  const now = Date.now();
  const token = sessionToken(config, now);
  const cookie = sessionCookie(requestWith(''), token).split(';')[0];
  assert.equal(validSession(config, requestWith(`a=1; ${cookie}`), now), true);
  assert.equal(validSession(config, requestWith(cookie), now + 31 * 86_400_000), false);
  assert.equal(validSession({ ...config, passwordHash: hashFor('new-password-1') }, requestWith(cookie), now), false);
  assert.equal(validSession({ ...config, secret: 'y'.repeat(40) }, requestWith(cookie), now), false);
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), exp: now + 9e12 })).toString('base64url');
  assert.equal(validSession(config, requestWith(`ieltsbuddy_session=${forged}.${signature}`), now), false);
  assert.equal(validSession(config, requestWith(''), now), false);
});

test('Cookie 属性：HttpOnly + SameSite=Lax，经 HTTPS 代理时加 Secure，登出清空', () => {
  const plain = sessionCookie(requestWith(''), 'abc');
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(sessionCookie(requestWith('', { 'x-forwarded-proto': 'https' }), 'abc'), /; Secure/);
  assert.match(sessionCookie(requestWith(''), ''), /Max-Age=0/);
});

test('只有本机代理转发时才采信 X-Real-IP，IPv6 按 /64 归并', () => {
  const forwarded = { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' };
  assert.equal(clientAddress({ headers: forwarded, socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.9');
  assert.equal(clientAddress({ headers: forwarded, socket: { remoteAddress: '::ffff:192.0.2.77' } }), '192.0.2.77');
  assert.equal(rateLimitKey('2408:8207:abcd:12:1::5'), '2408:8207:abcd:12::/64');
  assert.equal(rateLimitKey('203.0.113.9'), '203.0.113.9');
});

test('登录限流：5 次失败后锁定，成功清零，表满时不淘汰已锁定来源', () => {
  const limiter = loginLimiter({ limit: 2 });
  for (let i = 0; i < 5; i += 1) limiter.fail('a');
  assert.equal(limiter.blocked('a'), true);
  limiter.fail('b');
  assert.equal(limiter.blocked('c'), false);
  assert.equal(limiter.blocked('a'), true);
  limiter.clear('a');
  assert.equal(limiter.blocked('a'), false);
  const timed = loginLimiter({ windowMs: 1000 });
  for (let i = 0; i < 5; i += 1) timed.fail('x', 0);
  assert.equal(timed.blocked('x', 500), true);
  assert.equal(timed.blocked('x', 1500), false);
});

test('Groq 转写：verbose_json 分段，lang=auto 时不传 language', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const body = Buffer.concat(await Array.fromAsync(req)).toString('latin1');
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: ' Hello there. ', duration: 4.2, segments: [{ start: 0, end: 4.2, text: ' Hello there. ' }, { start: 4.2, end: 5, text: ' ' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = sttConfig({ GROQ_BASE_URL: `http://127.0.0.1:${server.address().port}/openai/v1/`, GROQ_API_KEY: 'gsk_test' });
  try {
    const result = await transcribe(config, Buffer.from('fake-audio'), { filename: 'speech.webm', mime: 'audio/webm', language: '', prompt: 'Describe a park' });
    assert.deepEqual(result, { text: 'Hello there.', duration: 4.2, segments: [{ start: 0, end: 4.2, text: 'Hello there.' }] });
    assert.equal(seen[0].url, '/openai/v1/audio/transcriptions');
    assert.equal(seen[0].auth, 'Bearer gsk_test');
    assert.match(seen[0].body, /name="model"\r\n\r\nwhisper-large-v3/);
    assert.match(seen[0].body, /name="response_format"\r\n\r\nverbose_json/);
    assert.match(seen[0].body, /filename="speech\.webm"/);
    assert.doesNotMatch(seen[0].body, /name="language"/);
    await transcribe(config, Buffer.from('x'), {});
    assert.match(seen[1].body, /name="language"\r\n\r\nen/);
  } finally {
    server.close();
  }
  await assert.rejects(transcribe(sttConfig({}), Buffer.from('x')), { code: 'STT_NOT_CONFIGURED' });
});

test('口语录音换算语速', () => {
  assert.deepEqual(speakingPace('I really like going to the park on weekends', { duration: 6 }), { seconds: 6, wpm: 90 });
  assert.equal(speakingPace('typed answer', undefined), null);
});
