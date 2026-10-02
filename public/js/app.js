import './select.js';
import { guestView } from './views/guest.js';
import { api, esc, $, $$, toast, viewState, cleanup, bridge, delegate, requireLogin, session, setSession, refreshAccess, ensureFeature, warnMainAi, locateSettings, confirmAction } from './core.js';
import { markdown } from './md.js';
import { micButton } from './mic.js';
import { homeView, planView, historyView, settingsView } from './views/home.js';
import { drillView, taskView, mockListView, mockView, predictView } from './views/practice.js';
import { courseView, lessonView, libraryView, newsView, vocabView, listeningListView, listeningView, storiesView } from './views/study.js';

const routes = [
  ['/', homeView, 'home'], ['/plan', planView, 'plan'], ['/history', historyView, 'history'], ['/settings', settingsView, 'settings'],
  ['/drill/:skill', drillView, 'home'], ['/task/:id', taskView, 'home'], ['/mock', mockListView, 'home'], ['/mock/:id', mockView, 'home'],
  ['/predict', predictView, 'home'], ['/course', courseView, 'home'], ['/course/:skill', courseView, 'home'], ['/lesson/:id', lessonView, 'home'],
  ['/library', libraryView, 'home'], ['/news', newsView, 'home'], ['/vocab', vocabView, 'home'], ['/vocab/:tab', vocabView, 'home'],
  ['/listening', listeningListView, 'home'], ['/listening/:docId', listeningView, 'home'], ['/stories', storiesView, 'home'],
].map(([pattern, view, nav]) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}$`);
  return { regex, keys, view, nav };
});




async function navigate() {
  for (const fn of cleanup) fn();
  cleanup.clear();
  viewState.context = '';
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  const view = $('#view');
  delegate(view, null);
  const match = routes.map((r) => ({ r, m: r.regex.exec(path) })).find((x) => x.m);
  document.body.classList.remove('menu-open');
  if (!match) { view.innerHTML = '<div class="empty">页面不存在，<a href="#/">回到首页</a></div>'; return; }
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === match.r.nav && (match.r.nav !== 'home' || path === '/')));
  const params = Object.fromEntries(match.r.keys.map((key, i) => [key, decodeURIComponent(match.m[i + 1])]));
  view.innerHTML = '<div class="loading">加载中…</div>';
  view.scrollTop = 0;
  try {
    if (!session.authenticated) await guestView(view, path, params);
    else {
      await match.r.view(view, params);
      if (path === '/settings' && new URLSearchParams(query).get('section') === 'llm') locateSettings('settings-llm');
    }
  } catch (error) {
    if (error.status === 401) await guestView(view, path, params);
    else view.innerHTML = `<div class="empty">出错了：${esc(error.message)}</div>`;
  }
}

// —— 老师对话 ——
const chat = { id: null, streaming: false };

function appendMessage(role, content = '') {
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.innerHTML = role === 'assistant' ? markdown(content) : esc(content).replace(/\n/g, '<br>');
  $('#chat-log').append(node);
  node.scrollIntoView({ block: 'end' });
  return node;
}

export async function loadConversations() {
  const items = session.authenticated ? await api('/api/conversations').catch(() => []) : [];
  $('#clear-conversations').hidden = !items.length;
  $('#conversations').innerHTML = items.length
    ? items.map((c) => `<div class="conv ${c.id === chat.id ? 'active' : ''}" data-id="${c.id}"><span>${esc(c.title || '对话')}</span><button type="button" data-del="${c.id}" aria-label="删除">✕</button></div>`).join('')
    : `<div class="conversations-empty">${session.authenticated ? '还没有对话' : '登录后查看历史对话'}</div>`;
}

async function openConversation(id) {
  chat.id = id;
  const messages = await api(`/api/conversations/${id}`);
  $('#chat-log').innerHTML = '';
  for (const m of messages) appendMessage(m.role, m.content);
  openChat();
  loadConversations();
}

function resetChat() {
  chat.id = null;
  $('#chat-log').innerHTML = `<div class="msg assistant intro">${markdown('你好，我是你的雅思老师。我会结合你的学员档案、练习记录与已扫描资料出题、批改、讲解，也可以帮你安排今天练什么。')}</div>`;
  loadConversations();
}

export function openChat() { document.body.classList.add('chat-open'); }

async function ask(message) {
  if (chat.streaming || !message.trim() || !ensureFeature('llm')) return false;
  openChat();
  chat.streaming = true;
  appendMessage('user', message);
  const node = appendMessage('assistant', '');
  node.classList.add('pending');
  let text = '';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: chat.id, message, context: viewState.context }),
    });
    if (response.status === 401) { setSession({ authenticated: false }); requireLogin(); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.code === 'AI_NOT_CONFIGURED') warnMainAi();
      throw new Error(data.error || `请求失败（${response.status}）`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sources = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/^data:\s*/, '');
        buffer = buffer.slice(index + 2);
        const event = JSON.parse(line);
        if (event.type === 'meta') { chat.id = event.conversationId; sources = event.sources || []; }
        if (event.type === 'delta') { text += event.text; node.classList.remove('pending'); node.innerHTML = markdown(text); node.scrollIntoView({ block: 'end' }); }
        if (event.type === 'error') throw new Error(event.message);
      }
    }
    if (sources.length) node.insertAdjacentHTML('beforeend', `<div class="sources">参考资料：${sources.map((s) => `<a href="#/library" title="${esc(s.path)}">《${esc(s.title)}》</a>`).join(' ')}</div>`);
  } catch (error) {
    node.classList.remove('pending');
    node.classList.add('error');
    node.textContent = error.message;
  } finally {
    chat.streaming = false;
    loadConversations();
  }
}

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#composer-input');
  const message = input.value;
  if (!message.trim() || chat.streaming || !ensureFeature('llm')) return;
  input.value = '';
  input.style.height = '';
  ask(message);
});
$('#composer-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer-input').addEventListener('input', (event) => { event.target.style.height = ''; event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`; });
$$('[data-ask]').forEach((button) => button.addEventListener('click', () => ask(button.dataset.ask)));
$('#new-chat').addEventListener('click', () => { resetChat(); openChat(); });
$('#conversations').addEventListener('click', async (event) => {
  const del = event.target.closest('[data-del]');
  if (del) {
    if (chat.streaming) { toast('请等老师回复完成后再删除'); return; }
    if (!await confirmAction('删除这段对话？', '删除后无法恢复，其他对话和设置会保留。')) return;
    try { await api(`/api/conversations/${del.dataset.del}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'error'); return; }
    if (Number(del.dataset.del) === chat.id) resetChat(); else loadConversations();
    return;
  }
  const item = event.target.closest('.conv');
  if (item) openConversation(Number(item.dataset.id)).catch((e) => toast(e.message, 'error'));
});
$('#clear-conversations').addEventListener('click', async () => {
  if (chat.streaming) { toast('请等老师回复完成后再清除'); return; }
  if (!await confirmAction('清除所有历史对话？', '全部对话及消息将被删除，无法恢复。设置和练习记录会保留。', '清除全部')) return;
  try { await api('/api/conversations', { method: 'DELETE' }); resetChat(); toast('历史对话已清除'); }
  catch (error) { toast(error.message, 'error'); }
});
$('#menu-btn').addEventListener('click', () => { document.body.classList.remove('chat-open'); document.body.classList.toggle('menu-open'); });
$('#scrim').addEventListener('click', () => document.body.classList.remove('menu-open', 'chat-open'));
$('#chat-btn').addEventListener('click', () => { document.body.classList.remove('menu-open'); document.body.classList.toggle('chat-open'); });
$('#chat-close').addEventListener('click', () => document.body.classList.remove('chat-open'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { document.body.classList.remove('menu-open', 'chat-open'); hideGate(); }
});

$('#ai-warning a').addEventListener('click', () => {
  document.body.classList.remove('chat-open', 'menu-open');
  $('#ai-warning').hidden = true;
  if (location.hash === '#/settings?section=llm') locateSettings('settings-llm');
});
bridge.ask = ask;
$('#composer .send').before(micButton($('#composer-input'), { lang: 'auto', scoped: false }));

// —— 登录 ——
// 新安装先创建管理员，已有账号直接登录。
function showGate(status = {}) {
  document.body.classList.remove('menu-open', 'chat-open');
  $('#gate').hidden = false;
  $('.shell').inert = true;
  const setup = !status.configured;
  $('#login-form').dataset.setup = setup ? 'true' : 'false';
  $('#gate-note').textContent = setup ? '首次使用：创建管理员账号（密码至少 10 位）。请先在可信局域网完成设置，再开放外网访问。' : '登录后继续练习';
  $('#confirm-field').hidden = !setup;
  $('#login-form [name="passwordConfirm"]').required = setup;
  $('#login-form [name="password"]').minLength = setup ? 10 : 1;
  $('#login-form [name="password"]').autocomplete = setup ? 'new-password' : 'current-password';
  $('#gate-submit').textContent = setup ? '创建管理员并登录' : '登录';
  $('#login-form [name="username"]').focus();
}

let started = false;
function start() {
  hideGate();
  if (started) { navigate(); loadConversations(); return; }
  started = true;
  window.addEventListener('hashchange', navigate);
  resetChat();
  navigate();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  button.disabled = true;
  try {
    const status = await api(form.dataset.setup === 'true' ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    if (status.authenticated) { form.reset(); await refreshAccess(); start(); }
  } catch (error) {
    toast(error.message, 'error');
    const status = await fetch('/api/auth/status').then((r) => r.json()).catch(() => null);
    if (status && !status.authenticated) showGate(status);
  } finally {
    button.disabled = false;
  }
});
function hideGate() {
  $('#login-form [name="password"]').value = '';
  $('#login-form [name="passwordConfirm"]').value = '';
  $('#gate').hidden = true;
  $('.shell').inert = false;
}
$('#gate-close').addEventListener('click', hideGate);
$('#account-btn').addEventListener('click', () => {
  if (session.authenticated) location.hash = '#/settings'; else showGate(session);
});
window.addEventListener('ieltsbuddy:access', () => {
  $('#account-btn').textContent = session.authenticated ? '账户与设置' : '登录';
  if (!session.authenticated && started) { resetChat(); navigate(); }
});
window.addEventListener('ieltsbuddy:login', () => {
  refreshAccess().then((status) => { if (!status.authenticated) showGate(status); }).catch(() => showGate(session));
});
refreshAccess().catch(() => setSession({ authenticated: false })).then(start);
