// 通用工具：转义模板、请求、提示与格式化。
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => entities[c]);

class Raw { constructor(value) { this.value = value; } toString() { return this.value; } }
export const raw = (value) => new Raw(value);
const render = (value) => (value instanceof Raw ? value.value : Array.isArray(value) ? value.map(render).join('') : value == null || value === false ? '' : esc(value));
export const html = (strings, ...values) => raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  if (method !== 'GET' && !path.startsWith('/api/auth/') && !session.authenticated) { requireLogin(); throw new Error('请先登录'); }
  const response = await fetch(path, {
    method, keepalive,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith('/api/auth/')) { setSession({ authenticated: false }); requireLogin(); }
  if (!response.ok) {
    if (data.code === 'AI_NOT_CONFIGURED') warnMainAi();
    if (data.code === 'STT_NOT_CONFIGURED') toast('语音转写尚未测试通过，请到设置中验证', 'error');
    throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), { code: data.code, status: response.status });
  }
  return data;
}

// 会话过期或未登录时由外壳弹出登录页。
export const requireLogin = () => window.dispatchEvent(new Event('ieltsbuddy:login'));

export function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3000);
}

// 长耗时按钮：期间禁用并显示进度文案，失败弹出错误。
export async function busy(button, label, work) {
  const original = button?.innerHTML;
  if (button) { button.disabled = true; button.textContent = label; }
  try { return await work(); }
  catch (error) { if (error.code !== 'AI_NOT_CONFIGURED' && error.status !== 401) toast(error.message, 'error'); return undefined; }
  finally { if (button?.isConnected) { button.disabled = false; button.innerHTML = original; } }
}

export const skillNames = { listening: '听力', reading: '阅读', writing: '写作', speaking: '口语' };
export const skillIcons = { listening: '🎧', reading: '📖', writing: '✏️', speaking: '🎙️' };
export const formatSize = (bytes) => (bytes > 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const band = (value) => (value == null ? '—' : Number(value).toFixed(1));
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// 当前视图摘要，随对话发送给老师（“解释当前结果”等快捷追问依赖它）。
export const viewState = { context: '' };
export const setViewContext = (text) => { viewState.context = String(text || '').slice(0, 6000); };

// 路由切换前执行的清理（计时器、朗读、轮询）与对话桥接，避免视图与外壳循环依赖。
export const cleanup = new Set();
export const bridge = { ask: () => {} };

export function startTimer(node, minutes) {
  if (!node) return;
  const end = Date.now() + minutes * 60_000;
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    node.textContent = `⏱ ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    node.classList.toggle('late', left === 0);
  };
  tick();
  const timer = setInterval(tick, 1000);
  cleanup.add(() => clearInterval(timer));
}

// 视图级事件委托：同一视图重绘或切换路由时替换掉上一个处理器，避免重复绑定。
export function delegate(view, handler) {
  if (view._delegate) view.removeEventListener('click', view._delegate);
  view._delegate = handler;
  if (handler) view.addEventListener('click', handler);
}

export function confirmLogout() {
  const dialog = document.getElementById('logout-confirm');
  if (dialog.open) return Promise.resolve(false);
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'logout'), { once: true });
    dialog.showModal();
    dialog.querySelector('button[value="cancel"]').focus();
  });
}

// 这里只缓存本次页面会话的访问状态，业务数据仍由 NAS SQLite 保存。
export const session = { authenticated: false, configured: true, llmConfigured: false, sttConfigured: false };
export function setSession(status) {
  Object.assign(session, status);
  if (!session.authenticated) Object.assign(session, { llmConfigured: false, sttConfigured: false });
  window.dispatchEvent(new Event('ieltsbuddy:access'));
}
export async function refreshAccess() {
  const status = await fetch('/api/auth/status').then((r) => r.json());
  const health = status.authenticated ? await fetch('/api/health').then((r) => r.json()) : {};
  setSession({ ...status, llmConfigured: Boolean(health.llmConfigured), sttConfigured: Boolean(health.sttConfigured) });
  return session;
}
export function ensureFeature(provider = 'llm') {
  if (!session.authenticated) { requireLogin(); return false; }
  if (provider === 'llm' && !session.llmConfigured) { warnMainAi(); return false; }
  if (provider === 'stt' && !session.sttConfigured) { toast('请先在设置中测试并保存语音转写', 'error'); return false; }
  return true;
}
const warningTimers = new Map();
function showWarning(id) {
  const node = document.getElementById(id);
  const old = warningTimers.get(id) || [];
  old.forEach(clearTimeout);
  node.hidden = false; node.classList.remove('leaving');
  const timers = [setTimeout(() => {
    node.classList.add('leaving');
    timers.push(setTimeout(() => { node.hidden = true; node.classList.remove('leaving'); warningTimers.delete(id); }, 220));
  }, 3000)];
  warningTimers.set(id, timers);
}
export const warnMainAi = () => showWarning('ai-warning');
export const warnMicrophone = () => showWarning('mic-warning');
export function locateSettings(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
  target.classList.remove('settings-located');
  void target.offsetWidth;
  target.classList.add('settings-located');
  target.addEventListener('animationend', () => target.classList.remove('settings-located'), { once: true });
}
export function confirmAction(title, message, action = '确认删除') {
  const dialog = document.getElementById('action-confirm');
  if (dialog.open) return Promise.resolve(false);
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('p').textContent = message;
  dialog.querySelector('[value="confirm"]').textContent = action;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal(); dialog.querySelector('[value="cancel"]').focus();
  });
}
