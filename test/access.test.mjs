import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';

test('访客目录不泄露个人内容；AI 前置检查、真实接口测试、跨进程持久化与对话删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ib-access-'));
  const requests = [];
  let failure = false;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (failure) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'bad integration-main-secret' } })); return; }
    if (req.url === '/v1/audio/transcriptions') res.end(JSON.stringify({ text: '', segments: [], duration: 2 }));
    else if (JSON.parse(body).stream) { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"mock reply"}}]}\n\ndata: [DONE]\n\n'); }
    else res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  let child, base, cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, IELTS_LIBRARY_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    // server supports port 0 for isolated test listeners.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('启动超时')), 5000);
      child.stdout.on('data', (buf) => { const match = /listening on (http:\/\/[^\s]+)/.exec(String(buf)); if (match) { base = match[1]; clearTimeout(timer); resolve(); } });
      child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`启动退出 ${code}`)); });
    });
  }
  async function stop() { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  try {
    await start();
    const publicData = await (await request('/api/public/catalog')).json();
    assert.equal(publicData.catalog.speaking.length, 3);
    assert.deepEqual(Object.keys(publicData).sort(), ['catalog', 'courseTopics']);
    for (const path of ['/api/settings', '/api/profile', '/api/overview', '/api/conversations', '/api/stories', '/api/library', '/api/tasks']) assert.equal((await request(path)).status, 401, path);
    for (const path of ['/api/settings/test/llm', '/api/settings/test/stt', '/api/chat']) assert.equal((await request(path, 'POST', {})).status, 401, path);
    assert.equal((await request('/api/conversations', 'DELETE')).status, 401);
    const credentials = { username: 'learner', password: 'test-password-123', passwordConfirm: 'test-password-123' };
    const setup = await request('/api/auth/setup', 'POST', credentials);
    cookie = setup.headers.get('set-cookie').split(';')[0];
    for (const path of ['/api/chat', '/api/tasks', '/api/plan/today', '/api/lessons', '/api/predict', '/api/mocks', '/api/mocks/1/sections/0', '/api/vocab/topic', '/api/stories/1/analyze']) {
      const response = await request(path, 'POST', {});
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).code, 'AI_NOT_CONFIGURED', path);
    }
    assert.equal((await request('/api/settings/test/stt', 'POST')).status, 400);
    assert.equal((await request('/api/settings/test/llm', 'POST')).status, 400);
    assert.equal(requests.length, 0);
    await request('/api/profile', 'PUT', { name: 'Saved learner', notes: 'Persistent notes' });
    const mainPatch = { llmBaseUrl: endpoint, llmApiKey: 'integration-main-secret', llmModel: 'test-main' };
    assert.equal((await request('/api/settings', 'PUT', mainPatch)).status, 409);
    assert.equal((await (await request('/api/health')).json()).sttConfigured, false);
    const main = await request('/api/settings/test/llm', 'POST', mainPatch);
    assert.equal(main.status, 200); const mainResult = await main.json(); assert.equal(mainResult.ok, true); assert.ok(Date.parse(mainResult.verifiedAt));
    assert.equal((await (await request('/api/health')).json()).llmConfigured, false);
    assert.equal((await request('/api/settings', 'PUT', { ...mainPatch, llmModel: 'version-B' })).status, 409);
    assert.equal((await request('/api/settings', 'PUT', mainPatch)).status, 200);
    assert.equal((await (await request('/api/settings')).json()).verification.llm.verifiedAt, mainResult.verifiedAt);
    assert.equal(JSON.parse(requests.at(-1).body).model, 'test-main');
    assert.equal(requests.at(-1).path, '/v1/chat/completions');
    const speechPatch = { sttBaseUrl: endpoint, sttApiKey: 'integration-speech-secret', sttModel: 'test-stt' };
    const speech = await request('/api/settings/test/stt', 'POST', speechPatch); assert.equal(speech.status, 200);
    assert.equal(requests.at(-1).path, '/v1/audio/transcriptions');
    assert.match(requests.at(-1).body, /connection-test.wav/); assert.match(requests.at(-1).body, /test-stt/);
    assert.equal((await request('/api/settings', 'PUT', speechPatch)).status, 200);
    failure = true;
    const failed = await request('/api/settings/test/llm', 'POST'); assert.equal(failed.status, 502);
    const errorText = await failed.text(); assert.ok(!errorText.includes('integration-main-secret')); assert.match(errorText, /401/);
    assert.equal((await (await request('/api/health')).json()).llmConfigured, false);
    failure = false;
    assert.equal((await request('/api/settings/test/llm', 'POST', mainPatch)).status, 200);
    assert.equal((await request('/api/settings', 'PUT', mainPatch)).status, 200);
    for (const message of ['First conversation', 'Second conversation']) {
      const response = await request('/api/chat', 'POST', { message }); assert.equal(response.status, 200); assert.match(await response.text(), /mock reply/);
    }
    await request('/api/vocab', 'POST', { word: 'resilient', meaning: '有韧性的' });
    await request('/api/stories', 'POST', { title: 'My story', story: 'A persistent learning story' });
    // Seed an exercise as generated payloads are covered separately; test its real draft API.
    const db = openDatabase(join(dir, 'ieltsbuddy.sqlite'));
    const taskId = Number(db.prepare("INSERT INTO tasks (kind, skill, type, title, payload) VALUES ('drill','writing','task2','Draft task','{}')").run().lastInsertRowid); db.close();
    const draft = { essay: 'My unfinished essay' };
    assert.equal((await request(`/api/tasks/${taskId}/draft`, 'PUT', { answer: draft })).status, 200);
    const before = await (await request('/api/conversations')).json(); assert.equal(before.length, 2);
    await stop(); await start();
    assert.equal((await (await request('/api/profile')).json()).name, 'Saved learner');
    assert.deepEqual((await (await request(`/api/tasks/${taskId}`)).json()).answer, draft);
    assert.equal((await (await request('/api/vocab')).json()).length, 1);
    assert.equal((await (await request('/api/stories')).json()).length, 1);
    assert.equal((await (await request('/api/conversations')).json()).length, 2);
    assert.equal((await request(`/api/conversations/${before[0].id}`, 'DELETE')).status, 200);
    assert.equal((await (await request('/api/conversations')).json()).length, 1);
    const deleted = await (await request('/api/conversations', 'DELETE')).json(); assert.equal(deleted.deleted, 1);
    await stop(); await start();
    assert.equal((await (await request('/api/conversations')).json()).length, 0);
    assert.equal((await (await request('/api/settings')).json()).llm.model, 'test-main');
    assert.equal((await (await request('/api/vocab')).json()).length, 1);
    const verify = openDatabase(join(dir, 'ieltsbuddy.sqlite')); assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0); verify.close();
    cookie = '';
    assert.deepEqual(Object.keys(await (await request('/api/public/catalog')).json()).sort(), ['catalog','courseTopics']);
    assert.deepEqual(await (await request('/api/health')).json(), { ok: true });
  } finally { await stop(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); rmSync(dir, { recursive: true }); }
});
