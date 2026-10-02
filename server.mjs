import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { openDatabase, parseJson } from './src/db.mjs';
import { chatCompletion, llmReady, listModels, streamCompletion, sttReady, transcribe } from './src/llm.mjs';
import { effectiveSettings, publicSettings } from './src/settings.mjs';
import { verifiedConfig, verificationState, beginVerification, finishVerification, saveVerifiedSettings } from './src/verification.mjs';
import { readAdmin, createAdmin } from './src/admin.mjs';
import { clientAddress, loginLimiter, rateLimitKey, sessionCookie, sessionToken, validPassword, validSession } from './src/auth.mjs';
import { loadIeltsPlan, planSummary } from './src/plan.mjs';
import { buildContext, catalog, courseTopics, createMock, customTask, ensureMockSection, explainWord, analyzeStory, generateDailyPlan, generateLesson, generatePrediction, generateTask, gradeTask, mockScores, publicTask, topicWords, typeLabel } from './src/practice.mjs';
import { examCountdown, learnerSnapshot, libraryContext, readProfile, saveProfile, tutorSystemPrompt } from './src/tutor.mjs';
import { audioForTranscription, libraryState, mediaTypeOf, refreshLibrary, resolveMediaFile, searchLibrary } from './src/library.mjs';
import { reviewCard } from './src/srs.mjs';
import { clozeSegment, splitSentences } from './src/cloze.mjs';
import { httpError, todayKey } from './src/util.mjs';

const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
const planPath = process.env.WORKBENCH_PLAN_PATH || '';
const dataDir = process.env.DATA_DIR || './data';
const cacheDir = join(dataDir, 'cache');
const publicDir = join(import.meta.dirname, 'public');
process.umask(0o077);
const db = openDatabase(process.env.DATABASE_PATH || join(dataDir, 'ieltsbuddy.sqlite'));
// 主 AI、语音转写与资料目录每次按「设置页 > .env」合成，改设置无需重启。
const baseLlm = () => verifiedConfig(db, 'llm');
const stt = () => verifiedConfig(db, 'stt');
const libraryDir = () => effectiveSettings(db).libraryDir;
let auth = readAdmin(db);
const logins = loginLimiter();
const recordingsDir = join(dataDir, 'recordings');
const staticTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const currentLlm = () => baseLlm();

async function context() {
  const plan = await loadIeltsPlan(planPath);
  const profile = readProfile(db, plan);
  return buildContext(db, currentLlm(profile), profile, plan);
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw httpError(413, '请求体过大');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, '请求体不是有效 JSON'); }
}

async function readRaw(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, '录音过长，请分段录（单段不超过约 20 分钟）');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 浏览器 MediaRecorder 的格式：Chrome / Firefox 出 webm 或 ogg，Safari 出 mp4（存为 m4a）。Groq Whisper 都能识别。
const audioTypes = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const audioMime = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };

async function sendFile(req, res, file, type) {
  const { size } = await stat(file);
  const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!match) {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return createReadStream(file).pipe(res);
  }
  let start = match[1] === '' ? size - Number(match[2]) : Number(match[1]);
  let end = match[1] !== '' && match[2] !== '' ? Number(match[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
  createReadStream(file, { start, end }).pipe(res);
}

const getTask = (id) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw httpError(404, '练习不存在');
  return task;
};

const libraryCounts = () => db.prepare(`SELECT kind, COUNT(*) AS n, SUM(CASE WHEN text_status = 'ok' THEN 1 ELSE 0 END) AS indexed FROM library_documents GROUP BY kind`).all();

function listeningItem(item) {
  const segments = parseJson(item.segments, []).map((segment) => ({ ...segment, cloze: clozeSegment(segment.text) }));
  return { id: item.id, docId: item.doc_id, title: item.title, source: item.source, createdAt: item.created_at, segments };
}

function saveListening(docId, title, segments, source) {
  db.prepare('DELETE FROM listening_items WHERE doc_id = ?').run(docId);
  const id = db.prepare('INSERT INTO listening_items (doc_id, title, segments, source) VALUES (?, ?, ?, ?)').run(docId, title, JSON.stringify(segments), source).lastInsertRowid;
  return listeningItem(db.prepare('SELECT * FROM listening_items WHERE id = ?').get(id));
}

function stats() {
  const graded = db.prepare(`SELECT id, kind, skill, type, title, band, substr(graded_at, 1, 10) AS day FROM tasks WHERE status = 'graded' ORDER BY graded_at`).all();
  const days = new Set(graded.map((task) => task.day));
  let streak = 0;
  for (let cursor = new Date(`${todayKey()}T00:00:00Z`); days.has(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() - 1)) streak += 1;
  const perDay = {};
  for (const task of graded) perDay[task.day] = (perDay[task.day] || 0) + 1;
  return {
    streak,
    perDay,
    trend: graded.filter((task) => task.band != null && task.kind !== 'dictation').map((task) => ({ id: task.id, day: task.day, skill: task.skill, type: task.type, band: task.band })),
    recent: graded.slice(-40).reverse().map((task) => ({ ...task, typeLabel: typeLabel(task.skill, task.type) })),
    totals: {
      tasks: graded.length,
      vocab: db.prepare('SELECT COUNT(*) AS n FROM vocab').get().n,
      reviews: db.prepare('SELECT COALESCE(SUM(reps + lapses), 0) AS n FROM vocab').get().n,
      lessons: db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE status = 'done'").get().n,
      mocks: db.prepare("SELECT COUNT(*) AS n FROM mocks WHERE status = 'finished'").get().n,
    },
  };
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const message = String(body.message || '').trim();
  if (!message) throw httpError(400, '消息不能为空');
  const ctx = await context();
  requireMainAi(ctx.llm);
  let conversationId = Number(body.conversationId) || null;
  if (!conversationId || !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
    conversationId = Number(db.prepare('INSERT INTO conversations (title) VALUES (?)').run(message.slice(0, 40)).lastInsertRowid);
  }
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, 'user', message);
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 24').all(conversationId).reverse();
  const library = libraryContext(db, message);
  const system = tutorSystemPrompt({ profile: ctx.profile, plan: ctx.plan, snapshot: ctx.snapshot, library: library.text, viewContext: String(body.context || '').slice(0, 6000) });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'meta', conversationId, sources: library.sources });
  try {
    const reply = await streamCompletion(ctx.llm, [{ role: 'system', content: system }, ...history], (text) => send({ type: 'delta', text }));
    // 用户在另一设备删除会话后，不把在途生成的回复重新写回。
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return res.end();
    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, 'assistant', reply);
    db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
    send({ type: 'done' });
  } catch (error) {
    send({ type: 'error', message: error.message });
  }
  res.end();
}

// —— 登录 ——
// 所有业务接口均需登录；新安装先创建管理员。
const authorized = (req) => auth.enabled && validSession(auth, req);

function authStatus(req) {
  return { configured: auth.enabled, authenticated: authorized(req), username: auth.enabled && authorized(req) ? auth.username : '', setupRequired: !auth.enabled };
}

async function handleLogin(req, res) {
  if (!auth.enabled) throw httpError(503, '请先在网页创建管理员账号');
  const key = rateLimitKey(clientAddress(req));
  if (logins.blocked(key)) throw httpError(429, '尝试次数过多，请 15 分钟后再试');
  const { username, password } = await readJson(req);
  if (String(username || '').trim() !== auth.username || !validPassword(auth, password)) {
    logins.fail(key);
    throw httpError(401, '用户名或密码不正确');
  }
  logins.clear(key);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': sessionCookie(req, sessionToken(auth)) });
  res.end(JSON.stringify({ ...authStatus(req), authenticated: true, username: auth.username }));
}

const publicApi = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/logout', '/api/auth/setup', '/api/public/catalog']);

function guardApi(req, url) {
  // 写操作只接受同源页面发起（SameSite=Lax 之外再挡一层跨站请求）。
  const site = req.headers['sec-fetch-site'];
  if (!['GET', 'HEAD'].includes(req.method) && site && !['same-origin', 'none'].includes(site)) throw httpError(403, '拒绝来自其他网页的请求');
  const origin = req.headers.origin;
  if (!['GET', 'HEAD'].includes(req.method) && origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { throw httpError(403, '无效来源'); }
    if (originHost !== req.headers.host) throw httpError(403, '拒绝来自其他网页的请求');
  }
  if (publicApi.has(url.pathname)) return;
  if (!authorized(req)) throw httpError(401, '请先登录');
  if (req.method === 'POST' && /^\/api\/(chat|plan\/today|tasks|lessons|predict|mocks(?:\/\d+\/sections\/\d+)?|vocab\/topic|stories\/\d+\/analyze)$/.test(url.pathname)) requireMainAi();
  if (req.method === 'POST' && /^\/api\/(stt|listening\/doc\/\d+\/transcribe)$/.test(url.pathname) && !sttReady(stt())) throw Object.assign(httpError(503, '请先配置语音转写'), { code: 'STT_NOT_CONFIGURED' });
}

function requireMainAi(config = currentLlm(readProfile(db))) {
  if (!llmReady(config)) throw Object.assign(httpError(503, '请先配置主AI'), { code: 'AI_NOT_CONFIGURED' });
}


const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}$`);
  routes.push({ method, regex, keys, handler });
};

route('GET', '/api/public/catalog', (req, res) => sendJson(res, 200, { catalog, courseTopics }));
route('GET', '/api/health', async (req, res) => {
  if (!authorized(req)) return sendJson(res, 200, { ok: true });
  const ctx = await context();
  sendJson(res, 200, { ok: true, llmConfigured: llmReady(ctx.llm), model: ctx.llm.model, sttConfigured: sttReady(stt()), sttModel: stt().model, authConfigured: auth.enabled, libraryMounted: existsSync(libraryDir()), planLoaded: Boolean(ctx.plan) });
});
route('GET', '/api/auth/status', (req, res) => sendJson(res, 200, authStatus(req)));
route('POST', '/api/auth/setup', async (req, res) => {
  // 在发布到外网前由所有者首次创建；已配置的 NAS 登录不会触发此流程。
  auth = createAdmin(db, await readJson(req));
  res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': sessionCookie(req, sessionToken(auth)) });
  res.end(JSON.stringify({ configured: true, authenticated: true, username: auth.username }));
});
route('POST', '/api/auth/login', handleLogin);
route('POST', '/api/auth/logout', (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': sessionCookie(req, '') });
  res.end(JSON.stringify({ configured: auth.enabled, authenticated: false }));
});

// 麦克风录音转文字。lang=en 用于口语作答（固定英语更准），auto 用于老师对话（中英混说）。keep=1 时保存录音供回放。
route('POST', '/api/stt', async (req, res, params, url) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = audioTypes[type];
  if (!ext) throw httpError(415, `不支持的录音格式：${type || '未知'}`);
  const audio = await readRaw(req, 20 * 1024 * 1024);
  if (audio.length < 1000) throw httpError(400, '录音太短');
  const language = url.searchParams.get('lang') === 'auto' ? '' : 'en';
  const result = await transcribe(stt(), audio, { filename: `speech.${ext}`, mime: audioMime[ext], language, prompt: String(url.searchParams.get('prompt') || '') });
  let recordingId = null;
  if (url.searchParams.get('keep') === '1') {
    recordingId = `${randomUUID()}.${ext}`;
    await mkdir(recordingsDir, { recursive: true });
    await writeFile(join(recordingsDir, recordingId), audio);
  }
  sendJson(res, 200, { text: result.text, duration: result.duration, recordingId });
});
route('GET', '/api/recordings/:id', async (req, res, { id }) => {
  const match = /^[0-9a-f-]{36}\.(webm|ogg|m4a|mp3|wav)$/.exec(id);
  if (!match || !existsSync(join(recordingsDir, id))) throw httpError(404, '录音不存在');
  await sendFile(req, res, join(recordingsDir, id), audioMime[match[1]]);
});

route('GET', '/api/overview', async (req, res) => {
  const ctx = await context();
  const today = db.prepare('SELECT items FROM daily_plans WHERE date = ?').get(todayKey());
  sendJson(res, 200, {
    profile: ctx.profile, countdown: examCountdown(ctx.profile), snapshot: learnerSnapshot(db), llmConfigured: llmReady(ctx.llm), model: ctx.llm.model, sttConfigured: sttReady(stt()),
    today: today ? parseJson(today.items) : null, catalog, courseTopics, planLoaded: Boolean(ctx.plan), library: libraryCounts(),
  });
});

route('GET', '/api/plan', async (req, res) => {
  const plan = await loadIeltsPlan(planPath);
  sendJson(res, 200, { plan, summary: planSummary(plan) });
});
route('POST', '/api/plan/today', async (req, res) => {
  await generateDailyPlan(await context());
  sendJson(res, 200, parseJson(db.prepare('SELECT items FROM daily_plans WHERE date = ?').get(todayKey()).items));
});
route('PATCH', '/api/plan/today', async (req, res) => {
  const { index, done } = await readJson(req);
  const row = db.prepare('SELECT items FROM daily_plans WHERE date = ?').get(todayKey());
  if (!row) throw httpError(404, '今天还没有训练计划');
  const plan = parseJson(row.items);
  if (!plan.items[index]) throw httpError(400, '任务不存在');
  plan.items[index].done = Boolean(done);
  db.prepare('UPDATE daily_plans SET items = ? WHERE date = ?').run(JSON.stringify(plan), todayKey());
  sendJson(res, 200, plan);
});

route('GET', '/api/profile', async (req, res) => sendJson(res, 200, (await context()).profile));
route('PUT', '/api/profile', async (req, res) => {
  saveProfile(db, await readJson(req));
  sendJson(res, 200, (await context()).profile);
});
const settingsResponse = () => ({ ...publicSettings(db), verification: { llm: verificationState(db, 'llm'), stt: verificationState(db, 'stt') } });
route('GET', '/api/settings', (req, res) => sendJson(res, 200, settingsResponse()));
route('PUT', '/api/settings', async (req, res) => {
  const patch = await readJson(req);
  saveVerifiedSettings(db, patch);
  if ('llmModel' in patch) db.prepare("DELETE FROM profile WHERE key = 'model'").run();
  sendJson(res, 200, settingsResponse());
});
// 对已保存配置发起真实调用；不把响应写入对话或练习历史。
route('POST', '/api/settings/test/:provider', async (req, res, { provider }) => {
  if (!['llm', 'stt'].includes(provider)) throw httpError(400, '未知服务');
  const patch = await readJson(req);
  if (Object.keys(patch).some((key) => ![`${provider}BaseUrl`, `${provider}ApiKey`, `${provider}Model`].includes(key))) throw httpError(400, '只能测试对应服务的配置');
  const { config, attempt } = beginVerification(db, provider, patch);
  const started = Date.now();
  try {
    if (provider === 'llm') {
      const reply = await chatCompletion(config, [{ role: 'user', content: 'Reply with OK.' }], { maxTokens: 32, timeoutMs: 30_000 });
      if (typeof reply !== 'string' || !reply.trim()) throw httpError(502, '接口未返回有效的对话文本');
    } else {
      // 两秒静音 WAV：验证模型能接受音频，不申请麦克风权限。
      const audio = Buffer.alloc(44 + 16000 * 2 * 2);
      audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
      audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
      audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
      await transcribe(config, audio, { filename: 'connection-test.wav', mime: 'audio/wav', timeoutMs: 30_000 });
    }
    const verification = finishVerification(db, provider, attempt, true);
    if (!verification) throw httpError(409, '已有更新的测试，请以最后一次测试结果为准');
    sendJson(res, 200, { ok: true, model: config.model, elapsedMs: Date.now() - started, verifiedAt: verification.verifiedAt });
  } catch (error) {
    finishVerification(db, provider, attempt, false);
    const message = error.name === 'TimeoutError' ? '测试超时，请检查接口地址或 NAS 网络' : String(error.message || '测试失败');
    throw httpError(error.statusCode === 409 ? 409 : 502, message.replaceAll(config.apiKey, '[密钥已隐藏]'));
  }
});
route('GET', '/api/models', async (req, res) => sendJson(res, 200, { models: await listModels(baseLlm()), current: (await context()).llm.model }));

route('GET', '/api/conversations', (req, res) => sendJson(res, 200, db.prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50').all()));
route('DELETE', '/api/conversations', (req, res) => {
  const result = db.prepare('DELETE FROM conversations').run();
  sendJson(res, 200, { ok: true, deleted: Number(result.changes) });
});
route('GET', '/api/conversations/:id', (req, res, { id }) => sendJson(res, 200, db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(id)));
route('DELETE', '/api/conversations/:id', (req, res, { id }) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/chat', handleChat);

route('GET', '/api/tasks', (req, res, params, url) => {
  const skill = url.searchParams.get('skill');
  const rows = skill
    ? db.prepare('SELECT * FROM tasks WHERE skill = ? AND kind != ? ORDER BY id DESC LIMIT 50').all(skill, 'dictation')
    : db.prepare('SELECT * FROM tasks WHERE kind != ? ORDER BY id DESC LIMIT 50').all('dictation');
  sendJson(res, 200, rows.map((task) => ({ ...publicTask(task), payload: undefined, answer: undefined, result: undefined })));
});
route('POST', '/api/tasks', async (req, res) => {
  const { skill, type, topic } = await readJson(req);
  sendJson(res, 200, { id: await generateTask(await context(), skill, type, { topic: String(topic || '').slice(0, 300) }) });
});
route('POST', '/api/tasks/custom', async (req, res) => sendJson(res, 200, { id: customTask(db, await readJson(req)) }));
route('GET', '/api/tasks/:id', (req, res, { id }) => sendJson(res, 200, publicTask(getTask(id))));
route('PUT', '/api/tasks/:id/draft', async (req, res, { id }) => {
  const task = getTask(id);
  if (task.status === 'graded') throw httpError(409, '这道题已经批改过');
  const { answer } = await readJson(req);
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw httpError(400, '作答草稿格式无效');
  db.prepare("UPDATE tasks SET answer = ? WHERE id = ? AND status != 'graded'").run(JSON.stringify(answer), task.id);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/tasks/:id/submit', async (req, res, { id }) => {
  const task = getTask(id);
  if (task.status === 'graded') throw httpError(409, '这道题已经批改过');
  if (['writing', 'speaking'].includes(task.skill)) requireMainAi();
  const { answer } = await readJson(req);
  await gradeTask(await context(), task, answer);
  sendJson(res, 200, publicTask(getTask(id)));
});

route('GET', '/api/mocks', (req, res) => sendJson(res, 200, db.prepare('SELECT id, status, overall, started_at, finished_at FROM mocks ORDER BY id DESC LIMIT 30').all()));
route('POST', '/api/mocks', (req, res) => sendJson(res, 200, { id: createMock(db) }));
route('GET', '/api/mocks/:id', (req, res, { id }) => {
  const mock = db.prepare('SELECT * FROM mocks WHERE id = ?').get(id);
  if (!mock) throw httpError(404, '模考不存在');
  const sections = parseJson(mock.sections, []).map((section) => {
    const task = section.taskId ? db.prepare('SELECT status, band FROM tasks WHERE id = ?').get(section.taskId) : null;
    return { ...section, label: typeLabel(section.skill, section.type), status: task?.status || 'pending', band: task?.band ?? null };
  });
  sendJson(res, 200, { id: mock.id, status: mock.status, startedAt: mock.started_at, finishedAt: mock.finished_at, sections, scores: mockScores(db, parseJson(mock.sections, [])) });
});
route('POST', '/api/mocks/:id/sections/:index', async (req, res, { id, index }) => sendJson(res, 200, { taskId: await ensureMockSection(await context(), Number(id), Number(index)) }));

route('GET', '/api/lessons', (req, res) => sendJson(res, 200, db.prepare('SELECT id, skill, topic, status, created_at FROM lessons ORDER BY id DESC LIMIT 60').all()));
route('POST', '/api/lessons', async (req, res) => {
  const { skill, topic } = await readJson(req);
  if (!catalog[skill]) throw httpError(400, '未知技能');
  sendJson(res, 200, { id: await generateLesson(await context(), skill, String(topic || '').slice(0, 200)) });
});
route('GET', '/api/lessons/:id', (req, res, { id }) => {
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
  if (!lesson) throw httpError(404, '课程不存在');
  sendJson(res, 200, lesson);
});
route('PATCH', '/api/lessons/:id', async (req, res, { id }) => {
  const { done } = await readJson(req);
  db.prepare("UPDATE lessons SET status = ?, completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?").run(done ? 'done' : 'new', done ? 1 : 0, id);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/predict', (req, res) => sendJson(res, 200, parseJson(db.prepare("SELECT value FROM profile WHERE key = 'lastPrediction'").get()?.value, null)));
route('POST', '/api/predict', async (req, res) => {
  const prediction = { ...(await generatePrediction(await context())), generatedAt: new Date().toISOString() };
  db.prepare("INSERT INTO profile (key, value) VALUES ('lastPrediction', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(prediction));
  sendJson(res, 200, prediction);
});

route('GET', '/api/vocab', (req, res, params, url) => {
  const due = url.searchParams.get('due') === '1';
  const rows = due
    ? db.prepare('SELECT * FROM vocab WHERE due_at <= ? ORDER BY due_at, id LIMIT 200').all(todayKey())
    : db.prepare('SELECT * FROM vocab ORDER BY id DESC LIMIT 1000').all();
  sendJson(res, 200, rows);
});
route('POST', '/api/vocab', async (req, res) => {
  const body = await readJson(req);
  let entry = { word: String(body.word || '').trim(), meaning: body.meaning || '', example: body.example || '', note: body.note || '' };
  if (!entry.word) throw httpError(400, '请输入单词');
  if (body.auto) requireMainAi();
  if (body.auto) entry = { ...entry, ...(await explainWord(await context(), entry.word)) };
  db.prepare(`INSERT INTO vocab (word, meaning, example, note, source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(word) DO UPDATE SET meaning = COALESCE(NULLIF(excluded.meaning, ''), meaning), example = COALESCE(NULLIF(excluded.example, ''), example), note = COALESCE(NULLIF(excluded.note, ''), note)`)
    .run(entry.word, entry.meaning, entry.example, entry.note, String(body.source || '手动添加'));
  sendJson(res, 200, db.prepare('SELECT * FROM vocab WHERE word = ?').get(entry.word));
});
route('POST', '/api/vocab/batch', async (req, res) => {
  const { words = [], source = '' } = await readJson(req);
  const insert = db.prepare('INSERT OR IGNORE INTO vocab (word, meaning, example, note, source) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  for (const w of words.slice(0, 100)) if (w?.word) added += Number(insert.run(String(w.word).trim(), w.meaning || '', w.example || '', w.note || '', String(source)).changes);
  sendJson(res, 200, { added });
});
route('POST', '/api/vocab/topic', async (req, res) => {
  const { topic } = await readJson(req);
  if (!String(topic || '').trim()) throw httpError(400, '请输入话题');
  sendJson(res, 200, await topicWords(await context(), String(topic).slice(0, 100)));
});
route('POST', '/api/vocab/:id/review', async (req, res, { id }) => {
  const card = db.prepare('SELECT * FROM vocab WHERE id = ?').get(id);
  if (!card) throw httpError(404, '单词不存在');
  const { grade } = await readJson(req);
  const next = reviewCard(card, Math.min(5, Math.max(0, Number(grade) || 0)));
  db.prepare('UPDATE vocab SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_at = ? WHERE id = ?').run(next.ease, next.interval_days, next.reps, next.lapses, next.due_at, id);
  sendJson(res, 200, { ...card, ...next });
});
route('DELETE', '/api/vocab/:id', (req, res, { id }) => {
  db.prepare('DELETE FROM vocab WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/stories', (req, res) => sendJson(res, 200, db.prepare('SELECT * FROM speaking_stories ORDER BY updated_at DESC').all().map((s) => ({ ...s, analysis: parseJson(s.analysis) }))));
route('POST', '/api/stories', async (req, res) => {
  const { title, story } = await readJson(req);
  if (!String(title || '').trim() || !String(story || '').trim()) throw httpError(400, '标题和经历都要填写');
  sendJson(res, 200, { id: Number(db.prepare('INSERT INTO speaking_stories (title, story) VALUES (?, ?)').run(String(title).slice(0, 200), String(story).slice(0, 20000)).lastInsertRowid) });
});
route('PUT', '/api/stories/:id', async (req, res, { id }) => {
  const { title, story } = await readJson(req);
  db.prepare('UPDATE speaking_stories SET title = ?, story = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(String(title || '').slice(0, 200), String(story || '').slice(0, 20000), id);
  sendJson(res, 200, { ok: true });
});
route('DELETE', '/api/stories/:id', (req, res, { id }) => {
  db.prepare('DELETE FROM speaking_stories WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/stories/:id/analyze', async (req, res, { id }) => {
  const story = db.prepare('SELECT * FROM speaking_stories WHERE id = ?').get(id);
  if (!story) throw httpError(404, '素材不存在');
  const analysis = await analyzeStory(await context(), story);
  db.prepare('UPDATE speaking_stories SET analysis = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(analysis), id);
  sendJson(res, 200, analysis);
});

route('GET', '/api/library', (req, res, params, url) => {
  const q = url.searchParams.get('q');
  const rows = q
    ? db.prepare('SELECT id, path, title, kind, size, container, text_status, chars FROM library_documents WHERE path LIKE ? ORDER BY path LIMIT 2000').all(`%${q}%`)
    : db.prepare('SELECT id, path, title, kind, size, container, text_status, chars FROM library_documents ORDER BY path LIMIT 5000').all();
  sendJson(res, 200, { items: rows, state: libraryState, mounted: existsSync(libraryDir()), counts: libraryCounts() });
});
route('GET', '/api/library/status', (req, res) => sendJson(res, 200, libraryState));
route('POST', '/api/library/refresh', (req, res) => {
  if (!existsSync(libraryDir())) throw httpError(409, '资料目录未挂载');
  sendJson(res, 200, refreshLibrary(db, libraryDir(), cacheDir));
});
route('GET', '/api/library/search', (req, res, params, url) => sendJson(res, 200, searchLibrary(db, url.searchParams.get('q') || '', 20).map(({ chunk, ...hit }) => hit)));
route('GET', '/api/library/:id/media', async (req, res, { id }) => {
  const doc = db.prepare('SELECT * FROM library_documents WHERE id = ?').get(id);
  if (!doc || doc.kind === 'zip') throw httpError(404, '资料不存在');
  const file = await resolveMediaFile(doc, libraryDir(), cacheDir);
  await sendFile(req, res, file, mediaTypeOf(doc.entry || doc.path));
});

route('GET', '/api/listening/audio', (req, res) => {
  const items = db.prepare(`SELECT d.id, d.path, d.title, d.size, d.container, l.id AS itemId FROM library_documents d
    LEFT JOIN listening_items l ON l.doc_id = d.id WHERE d.kind = 'audio' ORDER BY d.path`).all();
  sendJson(res, 200, items);
});
route('GET', '/api/listening/doc/:docId', (req, res, { docId }) => {
  const doc = db.prepare("SELECT id, path, title FROM library_documents WHERE id = ? AND kind = 'audio'").get(docId);
  if (!doc) throw httpError(404, '音频不存在');
  const item = db.prepare('SELECT * FROM listening_items WHERE doc_id = ?').get(docId);
  sendJson(res, 200, { doc, item: item ? listeningItem(item) : null });
});
route('POST', '/api/listening/doc/:docId/transcribe', async (req, res, { docId }) => {
  const doc = db.prepare("SELECT * FROM library_documents WHERE id = ? AND kind = 'audio'").get(docId);
  if (!doc) throw httpError(404, '音频不存在');
  const file = await resolveMediaFile(doc, libraryDir(), cacheDir);
  const audio = await audioForTranscription(file, cacheDir, doc.id);
  const { segments } = await transcribe(stt(), audio, { filename: `${doc.id}.mp3` });
  if (!segments.length) throw httpError(502, '转写结果为空');
  sendJson(res, 200, saveListening(doc.id, doc.title, segments, 'stt'));
});
route('POST', '/api/listening/doc/:docId/manual', async (req, res, { docId }) => {
  const doc = db.prepare("SELECT * FROM library_documents WHERE id = ? AND kind = 'audio'").get(docId);
  if (!doc) throw httpError(404, '音频不存在');
  const { text } = await readJson(req);
  const segments = splitSentences(text).map((sentence) => ({ start: null, end: null, text: sentence }));
  if (!segments.length) throw httpError(400, '请粘贴原文');
  sendJson(res, 200, saveListening(doc.id, doc.title, segments, 'manual'));
});
route('POST', '/api/listening/items/:id/attempt', async (req, res, { id }) => {
  const item = db.prepare('SELECT * FROM listening_items WHERE id = ?').get(id);
  if (!item) throw httpError(404, '精听材料不存在');
  const { correct, total } = await readJson(req);
  const result = { correct: Number(correct) || 0, total: Number(total) || 0, summary: `精听挖空 ${Number(correct) || 0}/${Number(total) || 0}` };
  db.prepare("INSERT INTO tasks (kind, skill, type, title, payload, status, result, graded_at) VALUES ('dictation', 'listening', 'dictation', ?, ?, 'graded', ?, CURRENT_TIMESTAMP)")
    .run(item.title, JSON.stringify({ listeningItemId: item.id }), JSON.stringify(result));
  sendJson(res, 200, result);
});

route('GET', '/api/stats', (req, res) => sendJson(res, 200, stats()));

async function serveStatic(pathname, res) {
  const file = normalize(join(publicDir, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(publicDir)) throw httpError(403, 'forbidden');
  let body;
  try { body = await readFile(file); } catch { body = null; }
  if (!body) {
    if (extname(pathname)) throw httpError(404, 'not found');
    body = await readFile(join(publicDir, 'index.html'));
  }
  const type = staticTypes[extname(file)] || 'text/html; charset=utf-8';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'self'; frame-src 'self'",
  });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) guardApi(req, url);
    for (const { method, regex, keys, handler } of routes) {
      const match = req.method === method && regex.exec(url.pathname);
      if (match) return await handler(req, res, Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])), url);
    }
    if (url.pathname.startsWith('/api/')) throw httpError(404, 'not found');
    await serveStatic(url.pathname, res);
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) console.error(`${req.method} ${url.pathname}:`, error.message);
    if (res.headersSent) return res.end();
    sendJson(res, error.statusCode || 500, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
}).listen(port, host, function () { console.log(`ieltsbuddy listening on http://${host}:${this.address().port}`); });
