import { api, html, raw, esc, band, busy, toast, skillNames, skillIcons, setViewContext, cleanup, confirmLogout, refreshAccess, locateSettings, $, $$ } from '../core.js';
import { trendSvg } from '../chart.js';
import { microphoneStatus } from '../mic.js';

// —— 今日训练（首页与学习计划页共用） ——
async function startPlanItem(item, button) {
  const go = (hash) => { location.hash = hash; };
  if (item.module === 'drill') {
    const result = await busy(button, '老师出题中…', () => api('/api/tasks', { method: 'POST', body: { skill: item.skill, type: item.type, topic: item.topic || '' } }));
    if (result) go(`#/task/${result.id}`);
  } else if (item.module === 'course') {
    const result = await busy(button, '老师备课中…', () => api('/api/lessons', { method: 'POST', body: { skill: item.skill || 'writing', topic: item.topic || item.title } }));
    if (result) go(`#/lesson/${result.id}`);
  } else {
    go({ vocab: '#/vocab', listening: '#/listening', stories: '#/stories', predict: '#/predict', mock: '#/mock' }[item.module] || '#/');
  }
}

function todayCard(container, today, onChange) {
  container.innerHTML = html`<section class="card today">
    <div class="row between"><h2>今日训练</h2><button class="btn small" id="gen-plan" type="button">${today ? '重新编排' : '让老师编排'}</button></div>
    ${today ? html`<p class="focus">🎯 ${today.focus}</p>
      <ol class="plan-items">${today.items.map((item, index) => html`<li class="${item.done ? 'done' : ''}">
        <label><input type="checkbox" data-done="${index}" ${item.done ? raw('checked') : ''}><span><strong>${item.title}</strong> · ${item.minutes || '?'} 分钟<br><small class="muted">${item.why || ''}</small></span></label>
        <button class="btn ghost small" type="button" data-start="${index}">开始</button></li>`)}</ol>`
      : html`<p class="muted">老师会结合你的计划、最近成绩和到期词汇，编排今天的训练。</p>`}
  </section>`.value;
  $('#gen-plan', container).addEventListener('click', async (event) => {
    const result = await busy(event.currentTarget, '编排中…约 30 秒', () => api('/api/plan/today', { method: 'POST' }));
    if (result) onChange(result);
  });
  $$('[data-done]', container).forEach((box) => box.addEventListener('change', async () => {
    const result = await api('/api/plan/today', { method: 'PATCH', body: { index: Number(box.dataset.done), done: box.checked } }).catch((e) => toast(e.message, 'error'));
    if (result) onChange(result);
  }));
  $$('[data-start]', container).forEach((button) => button.addEventListener('click', () => startPlanItem(today.items[Number(button.dataset.start)], button)));
}

function setupBanners(overview) {
  const banners = [];
  if (!overview.llmConfigured) banners.push('主AI尚未测试通过：到 <a href="#/settings">设置</a> 填写主AI的接口地址、密钥与模型，测试通过后保存。');
  if (!overview.library.length) banners.push('资料库还没扫描：到 <a href="#/library">云盘</a> 点「扫描资料库」，老师才能引用你的 NAS 雅思资料。');

  return banners.map((text) => `<div class="banner">${text}</div>`).join('');
}

export async function homeView(view) {
  const overview = await api('/api/overview');
  const { profile, countdown, snapshot } = overview;
  const averages = Object.entries(snapshot.averages);
  view.innerHTML = html`<div class="page">
    ${raw(setupBanners(overview))}
    <section class="hero">
      <div><h1>${profile.name ? `${profile.name}，` : ''}今天也向 ${profile.targetBand} 分靠近一点</h1>
      <p class="muted">${countdown != null ? `距离考试还有 ${countdown} 天` : '考试日期未定，可在设置里填写'} · 到期词汇 ${snapshot.dueVocab} 个${averages.length ? ` · 近期估分 ${averages.map(([s, b]) => `${skillNames[s]} ${b}`).join(' / ')}` : ''}</p></div>
    </section>
    <div class="home-grid">
      <div class="tile drill-tile">
        <div class="drill-face" aria-hidden="true"><div><h3>我要刷题</h3><small>听 · 说 · 读 · 写</small></div><span class="pill">15–30 分钟</span><i>🎯</i></div>
        <nav class="skills" aria-label="我要刷题：选择技能">${['listening', 'speaking', 'reading', 'writing'].map((s) => html`<a class="skill ${s}" href="#/drill/${s}">${skillIcons[s]}<b>${skillNames[s]}</b></a>`)}</nav>
      </div>
      <a class="tile mock" href="#/mock"><h3>做模考</h3><span class="pill">120–180 分钟</span><i>⏱️</i></a>
      <a class="tile course" href="#/course"><h3>学课程</h3><span class="pill">20–60 分钟</span><i>📘</i></a>
      <a class="tile predict" href="#/predict"><h3>预测命中</h3><span class="pill">10–20 分钟</span><i>📰</i></a>
    </div>
    <div id="today"></div>
    <h2 class="section-title">其他模块 <small>5</small></h2>
    <div class="modules">
      ${[
        ['#/library', '☁️', '云盘', '集中查看、搜索、预览 NAS 上的雅思资料，老师答疑时会引用。', 'lime'],
        ['#/news', '📰', '雅思备考资讯', '检索备考方法、考试政策、留学申请与院校信息。', 'violet'],
        ['#/vocab', '📖', '词汇', '复习今日到期词汇，学习个人生词和话题词书。', 'pink'],
        ['#/listening', '🎧', '听力精听', '用 NAS 真题音频生成按句挖空训练，按句重听并即时核对。', 'lime'],
        ['#/stories', '🎙️', '口语素材', '用你自己的经历和故事，匹配最相关的口语题目并补充表达。', 'violet'],
      ].map(([href, icon, title, desc, tone]) => html`<a class="module" href="${href}"><span class="module-icon ${tone}">${icon}</span><div><h3>${title}</h3><p>${desc}</p></div></a>`)}
    </div>
  </div>`.value;
  // 「我要刷题」默认是封面，悬停展开四项；触屏没有悬停，第一下点击先展开，点卡片外收起。
  const drill = $('.drill-tile', view);
  const canHover = matchMedia('(hover: hover)');
  drill.addEventListener('click', (event) => {
    if (canHover.matches || drill.classList.contains('open')) return;
    event.preventDefault();
    drill.classList.add('open');
  });
  const collapse = (event) => { if (!drill.contains(event.target)) drill.classList.remove('open'); };
  document.addEventListener('pointerdown', collapse);
  cleanup.add(() => document.removeEventListener('pointerdown', collapse));
  const renderToday = (today) => todayCard($('#today', view), today, renderToday);
  renderToday(overview.today);
  setViewContext(`首页。今日训练：${overview.today ? overview.today.items.map((i) => `${i.title}${i.done ? '（已完成）' : ''}`).join('；') : '尚未编排'}`);
}

export async function planView(view) {
  const [{ plan }, overview] = await Promise.all([api('/api/plan'), api('/api/overview')]);
  view.innerHTML = html`<div class="page">
    <h1>学习计划</h1>
    <div id="today"></div>
    ${plan ? html`<section class="card">
      <h2>工作台雅思计划</h2>
      <div class="facts"><span>目标 <b>${plan.goal}</b></span><span>每日 <b>${plan.dailyCommitment}</b></span><span>考试 <b>${overview.profile.examDate || plan.examDate}</b></span></div>
      <p>${plan.stage}</p>
      ${plan.warnings?.length ? html`<h3>注意</h3><ul>${plan.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
      ${plan.studyFlow?.length ? html`<h3>学习流程</h3><ol>${plan.studyFlow.map((s) => html`<li>${s}</li>`)}</ol>` : ''}
    </section>
    ${(plan.modules || []).map((m) => html`<details class="card plan-module">
      <summary><b>${m.name}</b> <span class="muted">目标 ${m.target || '-'} · ${m.duration || ''}</span></summary>
      ${m.content?.length ? html`<ul>${m.content.map((c) => html`<li>${c}</li>`)}</ul>` : ''}
      ${m.types?.length ? html`<p class="muted">题型：${m.types.join('、')}</p>` : ''}
      <h3>方法</h3><ol>${(m.strategies || []).map((s) => html`<li>${typeof s === 'string' ? s : s.text}${s.details?.length ? html`<ul>${s.details.map((d) => html`<li>${d}</li>`)}</ul>` : ''}</li>`)}</ol>
      ${m.bloggers?.length ? html`<h3>参考博主</h3><p>${m.bloggers.map((b) => html`<a href="${b.url}" target="_blank" rel="noopener noreferrer">${b.name}</a> `)}</p>` : ''}
    </details>`)}
    ${plan.tools?.length ? html`<section class="card"><h2>工具</h2><div class="links">${plan.tools.map((t) => html`<a href="${t.url}" target="_blank" rel="noopener noreferrer">${t.name}</a>`)}</div></section>` : ''}`
    : html`<div class="banner">未读取到工作台雅思计划。</div>`}
  </div>`.value;
  const renderToday = (today) => todayCard($('#today', view), today, renderToday);
  renderToday(overview.today);
  setViewContext('学习计划页：工作台雅思计划全文已在系统上下文中。');
}

export async function historyView(view) {
  const [stats, mocks] = await Promise.all([api('/api/stats'), api('/api/mocks')]);
  const days = Array.from({ length: 60 }, (_, i) => {
    const date = new Date(Date.now() - (59 - i) * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);
    return { date, n: stats.perDay[date] || 0 };
  });
  view.innerHTML = html`<div class="page">
    <h1>我的足迹</h1>
    <div class="stats">
      <div><b>${stats.streak}</b><span>连续练习天数</span></div>
      <div><b>${stats.totals.tasks}</b><span>完成练习</span></div>
      <div><b>${stats.totals.vocab}</b><span>生词</span></div>
      <div><b>${stats.totals.lessons}</b><span>完成课程</span></div>
      <div><b>${stats.totals.mocks}</b><span>完成模考</span></div>
    </div>
    <section class="card"><h2>近 60 天</h2><div class="heat">${days.map((d) => html`<i class="lv${Math.min(4, d.n)}" title="${d.date}：${d.n} 次"></i>`)}</div></section>
    <section class="card"><h2>估分趋势</h2>
      ${['listening', 'reading', 'writing', 'speaking'].map((skill) => html`<h3>${skillIcons[skill]} ${skillNames[skill]}</h3>${raw(trendSvg(stats.trend.filter((p) => p.skill === skill)))}`)}
    </section>
    ${mocks.length ? html`<section class="card"><h2>模考</h2><ul class="list">${mocks.map((m) => html`<li><a href="#/mock/${m.id}">模考 #${m.id}</a><span class="muted">${m.started_at.slice(0, 10)}</span><b>${m.status === 'finished' ? band(m.overall) : '进行中'}</b></li>`)}</ul></section>` : ''}
    <section class="card"><h2>最近练习</h2>
      ${stats.recent.length ? html`<ul class="list">${stats.recent.map((t) => html`<li>${t.kind === 'dictation' ? html`<span>🎧 精听 · ${t.title}</span>` : html`<a href="#/task/${t.id}">${skillIcons[t.skill]} ${t.typeLabel} · ${t.title}</a>`}<span class="muted">${t.day}</span><b>${band(t.band)}</b></li>`)}</ul>` : html`<p class="muted">还没有练习记录。</p>`}
    </section>
  </div>`.value;
  setViewContext(`我的足迹：连续 ${stats.streak} 天；最近练习 ${stats.recent.slice(0, 10).map((t) => `${skillNames[t.skill]} ${t.typeLabel} ${band(t.band)}`).join('；')}`);
}

const verifiedTime = (time) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(time));

export async function settingsView(view) {
  const [profile, health, settings] = await Promise.all([api('/api/profile'), api('/api/health'), api('/api/settings')]);
  view._microphoneCleanup?.();
  let microphonePermission;
  try { microphonePermission = await navigator.permissions?.query({ name: 'microphone' }); } catch { /* 部分浏览器不支持权限查询 */ }
  const microphone = microphoneStatus({ permission: microphonePermission?.state });
  const provider = (key, title, current) => html`<section class="provider-fields" id="settings-${key}" tabindex="-1"><h2>${title}</h2>
    <label>接口地址<input type="url" name="${key}BaseUrl" value="${current.baseUrl}" placeholder="https://api.example.com/v1"></label>
    <label>密钥<input type="password" name="${key}ApiKey" value="" autocomplete="new-password" placeholder="${current.hasKey ? '留空保持原密钥' : '填写 API 密钥'}"></label>
    <p class="muted small">${current.hasKey ? `已配置：${current.apiKeyMasked}` : '尚未配置密钥'}。密钥不回填到输入框。</p>
    <label>模型<input name="${key}Model" value="${current.model}" placeholder="服务商支持的模型名称"></label>
    <button class="btn ghost" data-test-provider="${key}" type="button">测试连接</button>
    <p class="muted small" data-test-note="${key}">先测试通过再保存。每次修改配置都需要重新测试；测试会调用服务商，可能产生少量费用。${key === 'stt' ? '使用内置测试音频，不申请麦克风权限；仅验证接口能接受音频。语音转写为可选项，未配置时话筒不可用。' : ''}</p>
    <p class="connection-result" data-test-result="${key}" role="status" hidden></p>
    ${key === 'stt' ? html`<p class="muted small" id="settings-microphone" tabindex="-1">麦克风需要浏览器授权，并通过 HTTPS（或 localhost 开发环境）访问；此项不主动申请录音权限。</p>` : ''}
  </section>`;
  view.innerHTML = html`<div class="page narrow"><h1>设置</h1>
    <section class="card settings-status"><h2>状态</h2><ul class="list">
      <li><button class="status-link" type="button" data-settings-target="settings-llm"><span>主AI<small>${health.model || '尚未选择模型'}${settings.verification.llm.verifiedAt ? ' · ' + verifiedTime(settings.verification.llm.verifiedAt) : ''}</small></span><b class="status-badge ${health.llmConfigured ? 'ready' : 'warning'}">${settings.verification.llm.verified ? '测试通过' : settings.verification.llm.filled ? '待测试' : '未填写'}</b><span class="status-go" aria-hidden="true">›</span></button></li>
      <li><button class="status-link" type="button" data-settings-target="settings-stt"><span>语音转写<small>${health.sttModel || '尚未选择模型'}${settings.verification.stt.verifiedAt ? ' · ' + verifiedTime(settings.verification.stt.verifiedAt) : ''}</small></span><b class="status-badge ${health.sttConfigured ? 'ready' : 'warning'}">${settings.verification.stt.verified ? '测试通过' : settings.verification.stt.filled ? '待测试' : '未填写'}</b><span class="status-go" aria-hidden="true">›</span></button></li>
      <li><div class="status-readonly"><span>麦克风</span><b id="microphone-status" class="status-badge ${microphone.style}">${microphone.label}</b></div></li>
      <li><button class="status-link" type="button" data-settings-target="settings-library"><span>资料目录</span><b class="status-badge ${health.libraryMounted ? 'ready' : 'warning'}">${health.libraryMounted ? '已挂载' : '未挂载'}</b><span class="status-go" aria-hidden="true">›</span></button></li>
      <li><div class="status-readonly"><span>登录保护</span><b class="status-badge ${health.authConfigured ? 'ready' : 'warning'}">${health.authConfigured ? '已开启' : '待初始化'}</b></div></li>
    </ul></section>
    <form class="card form" id="service-form">
      ${provider('llm', '主AI', settings.llm)}
      ${provider('stt', '语音转写', settings.stt)}
      <section class="provider-fields" id="settings-library" tabindex="-1"><h2>资料库</h2>
      <label>容器内资料目录<input name="libraryDir" value="${settings.libraryDir}" placeholder="/library"></label>
      <p class="muted small">先在 Docker 将 NAS 资料目录只读映射到容器（通常为 /library），再填写容器内路径。保存后到云盘重新扫描。</p></section>
      <p class="muted small">保存后立即生效；地址、模型或资料目录留空时使用环境变量的默认值。密钥留空保持不变。</p>
      <button class="btn" type="submit">保存服务设置</button>
      <p id="service-save-feedback" class="save-feedback" role="alert" hidden></p>
    </form>
    <form class="card form" id="profile-form"><h2>学员档案</h2>
      <label>称呼<input name="name" value="${profile.name}"></label>
      <div class="grid2">
        <label>目标总分<input name="targetBand" value="${profile.targetBand}"></label>
        <label>考试类型<select name="examType">${['Academic', 'General Training'].map((t) => html`<option value="${t}" ${t === profile.examType ? raw('selected') : ''}>${t === 'Academic' ? '学术类（Academic）' : '培训类（General Training）'}</option>`)}</select></label>
        <label>考试日期<input type="date" name="examDate" value="${profile.examDate}"></label>
        <label>每日分钟数<input type="number" name="dailyMinutes" value="${profile.dailyMinutes}" min="15" step="15"></label>
      </div>
      <p class="muted small">学术类通常用于大学、研究生申请；培训类通常用于移民、工作或非学位培训。听力与口语相同，阅读与写作不同；请按接收机构要求选择。</p>
      <label>口音目标<input name="accent" value="${profile.accent}"></label>
      <label>当前水平<textarea name="currentLevel" rows="3">${profile.currentLevel}</textarea></label>
      <label>给老师的备注<textarea name="notes" rows="3">${profile.notes}</textarea></label>
      <button class="btn" type="submit">保存学员档案</button>
    </form>
    <section class="card logout-row" id="settings-login" tabindex="-1"><button id="logout" type="button">退出登录</button></section>
  </div>`.value;
  if (microphonePermission) {
    const update = () => {
      const state = microphoneStatus({ permission: microphonePermission.state });
      const badge = $('#microphone-status', view);
      if (badge) { badge.textContent = state.label; badge.className = `status-badge ${state.style}`; }
    };
    microphonePermission.addEventListener('change', update);
    const release = () => { microphonePermission.removeEventListener('change', update); cleanup.delete(release); };
    view._microphoneCleanup = release;
    cleanup.add(release);
  }
  $$('[data-settings-target]', view).forEach((button) => button.addEventListener('click', () => locateSettings(button.dataset.settingsTarget)));
  const proofs = new Map();
  const providerDraft = (key) => Object.fromEntries(['BaseUrl', 'ApiKey', 'Model'].map((suffix) => { const name = key + suffix; return [name, $(`[name="${name}"]`, view).value.trim()]; }));
  const fingerprint = (key) => JSON.stringify(providerDraft(key));
  const originals = new Map(['llm', 'stt'].map((key) => [key, fingerprint(key)]));
  $$('[data-test-provider]', view).forEach((button) => {
    const key = button.dataset.testProvider;
    const section = $(`#settings-${key}`, view);
    const result = $(`[data-test-result="${key}"]`, view);
    const hasStoredKey = settings[key].hasKey;
    let testing = false;
    const updateButton = () => {
      const draft = providerDraft(key);
      button.disabled = testing || !draft[key + 'BaseUrl'] || !draft[key + 'Model'] || !(draft[key + 'ApiKey'] || hasStoredKey);
    };
    if (settings.verification[key].verified) proofs.set(key, fingerprint(key));
    updateButton();
    section.addEventListener('input', () => {
      proofs.delete(key); updateButton(); result.hidden = false;
      $('#service-save-feedback', view).hidden = true;
      result.className = 'connection-result warning'; result.textContent = '配置已修改，需要重新测试通过后才能保存。';
    });
    button.addEventListener('click', async () => {
      if (![...section.querySelectorAll('input')].every((input) => input.reportValidity())) return;
      const snapshot = fingerprint(key);
      const original = button.textContent;
      testing = true; updateButton(); button.textContent = '测试中…'; result.hidden = true; proofs.delete(key);
      try {
        const data = await api(`/api/settings/test/${key}`, { method: 'POST', body: providerDraft(key) });
        if (fingerprint(key) !== snapshot) {
          result.className = 'connection-result warning'; result.textContent = '测试期间配置已修改，最新版AI配置没有经过测试，请重新测试。';
        } else {
          proofs.set(key, snapshot); result.className = 'connection-result ready';
          result.textContent = `✓ 测试通过 · ${data.model} · ${verifiedTime(data.verifiedAt)} · ${(data.elapsedMs / 1000).toFixed(1)} 秒，请保存配置`;
        }
      } catch (error) {
        result.className = 'connection-result warning'; result.textContent = `测试失败：${error.message}`;
      } finally {
        result.hidden = false; testing = false; updateButton(); button.textContent = original;
      }
    });
  });
  $('#logout', view).addEventListener('click', async () => {
    if (!await confirmLogout()) return;
    try { await api('/api/auth/logout', { method: 'POST' }); location.reload(); }
    catch (error) { toast(error.message, 'error'); }
  });
  for (const [id, path, message] of [['service-form', '/api/settings', '服务设置已保存'], ['profile-form', '/api/profile', '学员档案已保存']]) {
    $(`#${id}`, view).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (id === 'service-form') {
        for (const key of ['llm', 'stt']) {
          const draft = providerDraft(key);
          const needsTest = settings[key].hasKey || Boolean(draft[key + 'ApiKey']) || fingerprint(key) !== originals.get(key);
          if (needsTest && proofs.get(key) !== fingerprint(key)) {
            const feedback = $('#service-save-feedback', view);
            feedback.textContent = `最新版${key === 'llm' ? '主AI' : '语音转写AI'}配置没有经过测试，请测试通过后再保存。`;
            feedback.hidden = false; feedback.scrollIntoView({ block: 'nearest' }); return;
          }
        }
      }
      await busy(event.submitter, '保存中…', async () => {
        try {
          await api(path, { method: 'PUT', body: Object.fromEntries(new FormData(event.currentTarget)) });
          await refreshAccess();
          await settingsView(view);
          if (id === 'service-form') {
            const feedback = $('#service-save-feedback', view); feedback.textContent = message; feedback.className = 'save-feedback ready'; feedback.hidden = false;
          } else toast(message);
        } catch (error) {
          if (id !== 'service-form') throw error;
          const feedback = $('#service-save-feedback', view); feedback.textContent = error.message; feedback.className = 'save-feedback'; feedback.hidden = false;
        }
      });
    });
  }
}
