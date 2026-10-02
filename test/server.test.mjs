import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('真实 HTTP：首次初始化、鉴权、同源保护、设置热更新和进程重启持久化', async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'ib-http-'));
  const base = `http://127.0.0.1:${port}`;
  const provider = createHttpServer(async (req, res) => { for await (const part of req) {} res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.includes('/audio/') ? { text: '', segments: [] } : { choices: [{ message: { content: 'OK' } }] })); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  let child;
  let cookie = '';
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, IELTS_LIBRARY_DIR: dir, WORKBENCH_PLAN_PATH: join(dir, 'no-plan.mjs') };
  const request = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('启动超时')), 5000);
      child.stdout.on('data', (data) => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`启动退出 ${code}`)); });
    });
  }
  async function stop() { if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  try {
    await start();
    assert.equal((await request('/api/settings')).status, 401);
    assert.deepEqual(await (await request('/api/health')).json(), { ok: true });
    const credentials = { username: 'learner', password: 'test-password-123', passwordConfirm: 'test-password-123' };
    assert.equal((await request('/api/auth/setup', 'POST', credentials, { origin: 'https://other.example' })).status, 403);
    assert.equal((await request('/api/auth/setup', 'POST', credentials, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const setup = await request('/api/auth/setup', 'POST', credentials);
    assert.equal(setup.status, 201);
    cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/auth/setup', 'POST', credentials)).status, 409);
    await request('/api/profile', 'PUT', { model: 'legacy-model' });
    const patch = { llmBaseUrl: endpoint, llmApiKey: 'integration-main-secret', llmModel: 'new-model', sttBaseUrl: endpoint, sttApiKey: 'integration-speech-secret', sttModel: 'whisper-test', libraryDir: dir };
    for (const key of ['llm', 'stt']) {
      const candidate = Object.fromEntries(Object.entries(patch).filter(([field]) => field.startsWith(key)));
      assert.equal((await request(`/api/settings/test/${key}`, 'POST', candidate)).status, 200);
    }
    const saved = await request('/api/settings', 'PUT', patch);
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes(patch.llmApiKey));
    const health = await (await request('/api/health')).json();
    assert.equal(health.model, 'new-model');
    assert.equal(health.llmConfigured, true);
    assert.equal(health.sttConfigured, true);
    assert.equal(health.planLoaded, false);
    assert.equal((await request('/api/settings', 'PUT', { llmModel: 'invalid-new-model', libraryDir: '/missing-integration-dir' })).status, 400);
    assert.equal((await (await request('/api/settings')).json()).llm.model, 'new-model');
    await stop(); await start();
    assert.equal((await (await request('/api/settings')).json()).llm.model, 'new-model');
    assert.equal((await (await request('/api/auth/status')).json()).authenticated, true);
    await request('/api/auth/logout', 'POST'); cookie = '';
    assert.equal((await request('/api/settings')).status, 401);
    const login = await request('/api/auth/login', 'POST', credentials);
    assert.equal(login.status, 200);
  } finally { await stop(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); rmSync(dir, { recursive: true }); }
});
