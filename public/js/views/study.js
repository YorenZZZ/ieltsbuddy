import { api, html, raw, esc, busy, toast, skillNames, skillIcons, formatSize, setViewContext, cleanup, bridge, delegate, $, $$ } from '../core.js';
import { markdown } from '../md.js';
import { micButton } from '../mic.js';

const mediaUrl = (id) => `/api/library/${id}/media`;

// —— 学课程 ——
export async function courseView(view, { skill = 'writing' }) {
  const [overview, lessons, library] = await Promise.all([api('/api/overview'), api('/api/lessons'), api('/api/library')]);
  const videos = library.items.filter((item) => item.kind === 'video');
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <h1>学课程</h1>
    <div class="tabs">${Object.keys(skillNames).map((s) => html`<a href="#/course/${s}" class="${s === skill ? 'active' : ''}">${skillIcons[s]} ${skillNames[s]}</a>`)}</div>
    <section class="card"><h2>选一节课</h2>
      <div class="chips-row">${(overview.courseTopics[skill] || []).map((topic) => html`<button class="chip" type="button" data-topic="${topic}">${topic}</button>`)}<button class="chip accent" type="button" data-topic="">老师按我的薄弱项选</button></div>
      <form class="row" id="custom-topic"><input name="topic" placeholder="或者输入想学的主题"><button class="btn" type="submit">开课</button></form>
    </section>
    <section class="card"><h2>我的课程</h2>
      ${lessons.length ? html`<ul class="list">${lessons.map((l) => html`<li><a href="#/lesson/${l.id}">${skillIcons[l.skill]} ${l.topic}</a><span class="muted">${l.created_at.slice(0, 10)}</span><b>${l.status === 'done' ? '已学完' : '未完成'}</b></li>`)}</ul>` : html`<p class="muted">还没有课程。</p>`}
    </section>
    ${videos.length ? html`<section class="card"><h2>资料库视频课</h2><ul class="list">${videos.map((v) => html`<li><span>🎬 ${v.title}</span><span class="muted">${formatSize(v.size)}</span><button class="btn ghost small" type="button" data-video="${v.id}">播放</button></li>`)}</ul><div id="player"></div></section>` : ''}
  </div>`.value;
  const start = async (button, topic) => {
    const result = await busy(button, '老师备课中…约 1 分钟', () => api('/api/lessons', { method: 'POST', body: { skill, topic } }));
    if (result) location.hash = `#/lesson/${result.id}`;
  };
  $$('[data-topic]', view).forEach((button) => button.addEventListener('click', () => start(button, button.dataset.topic)));
  $('#custom-topic', view).addEventListener('submit', (event) => { event.preventDefault(); start(event.submitter, new FormData(event.currentTarget).get('topic')); });
  $$('[data-video]', view).forEach((button) => button.addEventListener('click', () => {
    $('#player', view).innerHTML = `<video controls autoplay preload="metadata" src="${mediaUrl(button.dataset.video)}"></video>`;
  }));
}

export async function lessonView(view, { id }) {
  const lesson = await api(`/api/lessons/${id}`);
  view.innerHTML = html`<div class="page narrow">
    <a class="back" href="#/course/${lesson.skill}">← 学课程</a>
    <article class="card prose">${raw(markdown(lesson.content))}</article>
    <button class="btn" id="toggle" type="button">${lesson.status === 'done' ? '标记为未完成' : '学完了'}</button>
  </div>`.value;
  $('#toggle', view).addEventListener('click', async () => {
    await api(`/api/lessons/${id}`, { method: 'PATCH', body: { done: lesson.status !== 'done' } }).catch((e) => toast(e.message, 'error'));
    lessonView(view, { id });
  });
  setViewContext(`当前课程：${lesson.topic}\n${lesson.content.slice(0, 4000)}`);
}

// —— 云盘 ——
const kindIcon = { pdf: '📕', docx: '📄', doc: '📄', text: '📝', audio: '🎧', video: '🎬', zip: '🗜️' };
const textBadge = { ok: '已索引', empty: '扫描版·无文字', unsupported: '不支持抽字', error: '抽字失败', skipped: '过大跳过', pending: '待索引' };

export async function libraryView(view) {
  const data = await api('/api/library');
  const top = data.items.filter((item) => !item.container);
  const children = {};
  for (const item of data.items) if (item.container) (children[item.container] ||= []).push(item);
  const groups = {};
  for (const item of top) (groups[item.path.includes('/') ? item.path.split('/').slice(0, -1).join('/') : '根目录'] ||= []).push(item);
  const row = (item) => html`<li class="file">
    <span>${kindIcon[item.kind] || '📄'} ${item.title}</span>
    <span class="muted small">${formatSize(item.size)}${['pdf', 'docx', 'doc', 'text'].includes(item.kind) ? ` · ${textBadge[item.text_status] || item.text_status}` : ''}</span>
    ${['pdf', 'text', 'audio', 'video'].includes(item.kind) ? html`<button class="btn ghost small" type="button" data-open="${item.id}" data-kind="${item.kind}">打开</button>` : ''}
    ${item.kind === 'audio' ? html`<a class="btn ghost small" href="#/listening/${item.id}">精听</a>` : ''}
    ${item.kind === 'zip' && children[item.path]?.length ? html`<details><summary>${children[item.path].length} 个文件</summary><ul>${children[item.path].map(row)}</ul></details>` : ''}
  </li>`;
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <div class="row between"><h1>云盘</h1><button class="btn" id="refresh" type="button" ${data.state.running ? raw('disabled') : ''}>${data.state.running ? '扫描中…' : '扫描资料库'}</button></div>
    <p class="muted">只读读取 Docker 中映射的 NAS 资料目录。扫描会登记文件（含压缩包内条目）并抽取 PDF / Word / 文本文字建立全文索引；扫描版 PDF 没有文字层，暂不能被老师引用。</p>
    <p class="status" id="lib-status">${data.state.message || ''}</p>
    ${!data.mounted ? html`<div class="banner">资料目录未挂载，请检查 Docker 目录映射与设置页中的容器内路径。</div>` : ''}
    <form class="row" id="search"><input name="q" placeholder="全文搜索资料（中英文均可，中文至少 3 个字）"><button class="btn" type="submit">搜索</button></form>
    <div id="results"></div>
    <div id="viewer"></div>
    ${Object.entries(groups).map(([folder, items]) => html`<section class="card"><h2>📁 ${folder}</h2><ul class="files">${items.map(row)}</ul></section>`)}
    ${!data.items.length ? html`<div class="empty">资料库为空，点右上角「扫描资料库」。</div>` : ''}
  </div>`.value;
  $('#refresh', view).addEventListener('click', async (event) => {
    await busy(event.currentTarget, '启动中…', () => api('/api/library/refresh', { method: 'POST' }));
    poll();
  });
  const poll = () => {
    const timer = setInterval(async () => {
      const state = await api('/api/library/status').catch(() => null);
      if (!state) return;
      const node = $('#lib-status', view);
      if (node) node.textContent = `${state.message}${state.total ? `（${state.done}/${state.total}）` : ''}`;
      if (!state.running) { clearInterval(timer); libraryView(view); }
    }, 2000);
    cleanup.add(() => clearInterval(timer));
  };
  if (data.state.running) poll();
  $('#search', view).addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    const hits = await api(`/api/library/search?q=${encodeURIComponent(q)}`).catch((e) => { toast(e.message, 'error'); return []; });
    $('#results', view).innerHTML = html`<section class="card"><h2>搜索结果（${hits.length}）</h2><ul class="hits">${hits.map((hit) => html`<li><b>${hit.title}</b> <span class="muted small">${hit.path}</span><p>${raw(esc(hit.snippet).replace(/【/g, '<mark>').replace(/】/g, '</mark>'))}</p></li>`)}</ul></section>`.value;
  });
  const onOpen = (event) => {
    const button = event.target.closest('[data-open]');
    if (!button) return;
    const { open: id, kind } = button.dataset;
    if (kind === 'pdf' || kind === 'text') { window.open(mediaUrl(id), '_blank', 'noopener'); return; }
    $('#viewer', view).innerHTML = kind === 'video' ? `<video controls autoplay src="${mediaUrl(id)}"></video>` : `<audio controls autoplay src="${mediaUrl(id)}"></audio>`;
    $('#viewer', view).scrollIntoView({ block: 'nearest' });
  };
  delegate(view, onOpen);
}

// —— 备考资讯 ——
export async function newsView(view) {
  const questions = [
    '雅思机考和纸笔考怎么选？各自的优缺点和报名注意事项是什么？',
    '雅思考试的报名流程、费用、成绩有效期和重考规则，请按最新可知信息整理，并提醒我以官网为准。',
    '我规划申请 MIT Media Lab 硕士、之后读斯坦福博士，这类项目对雅思 / 托福的要求一般是怎样的？',
    '英国硕士申请常见的雅思总分和小分要求有哪些梯度？',
    '一个月冲刺、三个月备考、半年备考分别应该怎么安排？',
    '雅思口语题库每年什么时候换？换题季应该怎么准备？',
  ];
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <h1>雅思备考资讯</h1>
    <p class="muted">老师基于资料库与自身知识回答。模型知识有截止日期，考试政策、费用、院校要求请以官网为准。</p>
    <section class="card"><h2>常见问题</h2><div class="chips-row">${questions.map((q) => html`<button class="chip" type="button" data-q="${q}">${q}</button>`)}</div></section>
    <section class="card"><h2>在资料库中查找</h2><form class="row" id="search"><input name="q" placeholder="例如：官方指南 评分标准、机考 流程"><button class="btn" type="submit">搜索</button></form><div id="results"></div></section>
  </div>`.value;
  $$('[data-q]', view).forEach((button) => button.addEventListener('click', () => bridge.ask(button.dataset.q)));
  $('#search', view).addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    const hits = await api(`/api/library/search?q=${encodeURIComponent(q)}`).catch(() => []);
    $('#results', view).innerHTML = hits.length ? html`<ul class="hits">${hits.map((hit) => html`<li><b>${hit.title}</b><p>${raw(esc(hit.snippet).replace(/【/g, '<mark>').replace(/】/g, '</mark>'))}</p></li>`)}</ul>`.value : '<p class="muted">没有找到，先到云盘扫描资料库。</p>';
  });
}

// —— 词汇 ——
export async function vocabView(view, { tab = 'review' }) {
  const tabs = html`<div class="tabs">${[['review', '今日复习'], ['list', '生词本'], ['book', '话题词书']].map(([id, label]) => html`<a href="#/vocab/${id}" class="${tab === id ? 'active' : ''}">${label}</a>`)}</div>`;
  if (tab === 'review') {
    const due = await api('/api/vocab?due=1');
    let index = 0;
    const render = () => {
      const card = due[index];
      view.innerHTML = html`<div class="page narrow"><a class="back" href="#/">← 技能工具箱</a><h1>词汇</h1>${tabs}
        ${card ? html`<section class="card flash"><p class="muted small">${index + 1} / ${due.length}</p><h2 class="word">${card.word}</h2>
          <div id="back" hidden><p>${card.meaning}</p>${card.example ? html`<p class="example">${card.example}</p>` : ''}${card.note ? html`<p class="muted">${card.note}</p>` : ''}</div>
          <button class="btn" id="reveal" type="button">显示释义</button>
          <div class="grades" id="grades" hidden>${[[1, '忘了'], [3, '模糊'], [4, '记得'], [5, '简单']].map(([g, l]) => html`<button class="btn ghost" type="button" data-grade="${g}">${l}</button>`)}</div></section>`
        : html`<div class="empty">🎉 今天的词都复习完了。到「生词本」或「话题词书」加新词。</div>`}</div>`.value;
      if (!card) return;
      $('#reveal', view).addEventListener('click', () => { $('#back', view).hidden = false; $('#grades', view).hidden = false; $('#reveal', view).hidden = true; });
      $$('[data-grade]', view).forEach((button) => button.addEventListener('click', async () => {
        await api(`/api/vocab/${card.id}/review`, { method: 'POST', body: { grade: Number(button.dataset.grade) } }).catch((e) => toast(e.message, 'error'));
        index += 1;
        render();
      }));
      setViewContext(`词汇复习：当前词 ${card.word}`);
    };
    render();
    return;
  }
  if (tab === 'list') {
    const words = await api('/api/vocab');
    view.innerHTML = html`<div class="page"><a class="back" href="#/">← 技能工具箱</a><h1>词汇</h1>${tabs}
      <form class="card row" id="add"><input name="word" placeholder="输入单词或词组，老师自动补释义、例句与搭配" required><button class="btn" type="submit">添加</button></form>
      <section class="card"><h2>生词本（${words.length}）</h2><ul class="words">${words.map((w) => html`<li><div><b>${w.word}</b> <span>${w.meaning}</span>${w.example ? html`<p class="example">${w.example}</p>` : ''}<small class="muted">下次复习 ${w.due_at} · ${w.source || ''}</small></div><button class="icon-btn" type="button" data-del="${w.id}" aria-label="删除">✕</button></li>`)}</ul></section></div>`.value;
    $('#add', view).addEventListener('submit', async (event) => {
      event.preventDefault();
      const word = new FormData(event.currentTarget).get('word');
      const result = await busy(event.submitter, '查词中…', () => api('/api/vocab', { method: 'POST', body: { word, auto: true } }));
      if (result) vocabView(view, { tab });
    });
    $$('[data-del]', view).forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('从生词本删除？')) return;
      await api(`/api/vocab/${button.dataset.del}`, { method: 'DELETE' });
      vocabView(view, { tab });
    }));
    return;
  }
  view.innerHTML = html`<div class="page"><a class="back" href="#/">← 技能工具箱</a><h1>词汇</h1>${tabs}
    <form class="card row" id="topic"><input name="topic" placeholder="话题，例如 environment、technology、urbanisation" required><button class="btn" type="submit">生成词书</button></form>
    <div id="book"></div></div>`.value;
  $('#topic', view).addEventListener('submit', async (event) => {
    event.preventDefault();
    const topic = new FormData(event.currentTarget).get('topic');
    const result = await busy(event.submitter, '整理中…', () => api('/api/vocab/topic', { method: 'POST', body: { topic } }));
    if (!result) return;
    $('#book', view).innerHTML = html`<section class="card"><h2>${topic}</h2><ul class="words">${result.words.map((w, i) => html`<li><label><input type="checkbox" data-i="${i}" checked> <b>${w.word}</b> ${w.meaning}</label>${w.example ? html`<p class="example">${w.example}</p>` : ''}</li>`)}</ul><button class="btn" id="save" type="button">加入生词本</button></section>`.value;
    $('#save', view).addEventListener('click', async (e) => {
      const words = $$('[data-i]:checked', view).map((box) => result.words[Number(box.dataset.i)]);
      const saved = await busy(e.currentTarget, '加入中…', () => api('/api/vocab/batch', { method: 'POST', body: { words, source: `词书：${topic}` } }));
      if (saved) toast(`已加入 ${saved.added} 个新词`);
    });
  });
}

// —— 听力精听 ——
export async function listeningListView(view) {
  const audio = await api('/api/listening/audio');
  const groups = {};
  for (const item of audio) (groups[item.container || item.path.split('/').slice(0, -1).join('/') || '根目录'] ||= []).push(item);
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <h1>听力精听</h1>
    <p class="muted">选一段 NAS 上的真题音频：经 Groq 语音转写（Whisper）得到逐句原文与时间戳，生成按句挖空，可逐句重听并即时核对。也可以粘贴原文。</p>
    ${audio.length ? Object.entries(groups).map(([group, items]) => html`<details class="card" ${Object.keys(groups).length === 1 ? raw('open') : ''}><summary><b>${group}</b> <span class="muted">${items.length} 段</span></summary>
      <ul class="files">${items.map((item) => html`<li class="file"><a href="#/listening/${item.id}">🎧 ${item.title}</a><span class="muted small">${formatSize(item.size)}</span>${item.itemId ? html`<span class="pill">已准备</span>` : ''}</li>`)}</ul></details>`)
    : html`<div class="empty">资料库里还没有音频。到 <a href="#/library">云盘</a> 扫描资料库（压缩包内的音频也会被登记）。</div>`}
  </div>`.value;
}

export async function listeningView(view, { docId }) {
  const { doc, item } = await api(`/api/listening/doc/${docId}`);
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/listening">← 听力精听</a>
    <h1>🎧 ${doc.title}</h1>
    <audio id="audio" controls preload="metadata" src="${mediaUrl(doc.id)}"></audio>
    ${item ? html`<div class="row between"><p class="muted small">${item.source === 'stt' ? '原文来自语音转写，可能有个别错误' : '原文为手动粘贴（无时间戳，按句重听不可用）'} · 共 ${item.segments.length} 句</p><button class="btn ghost small" id="redo" type="button">重新准备</button></div>
      <ol class="segments">${item.segments.map((s, i) => html`<li data-seg="${i}">
        ${s.start != null ? html`<button class="icon-btn" type="button" data-play="${i}" aria-label="重听本句">▶</button>` : ''}
        <span class="cloze">${s.cloze.parts.map((part) => (part.text != null ? part.text : html`<input class="blank" data-blank="${part.blank}" size="${Math.max(4, s.cloze.answers[part.blank].length)}" autocomplete="off" spellcheck="false">`))}</span>
        <button class="btn ghost small" type="button" data-check="${i}">核对</button></li>`)}</ol>
      <button class="btn" id="finish" type="button">提交本次成绩</button>`
    : html`<section class="card" id="prepare"><h2>准备精听材料</h2>
      <button class="btn" id="stt" type="button">AI 转写（Groq Whisper）</button>
      <details><summary>或粘贴原文</summary><form id="manual"><textarea name="text" rows="8" placeholder="粘贴这段录音的原文"></textarea><button class="btn" type="submit">生成挖空</button></form></details></section>`}
  </div>`.value;
  const audio = $('#audio', view);
  cleanup.add(() => audio.pause());
  if (!item) {
    $('#stt', view).addEventListener('click', async (event) => {
      const result = await busy(event.currentTarget, '转写中…长音频需几分钟', () => api(`/api/listening/doc/${docId}/transcribe`, { method: 'POST' }));
      if (result) listeningView(view, { docId });
    });
    $('#manual', view).addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await busy(event.submitter, '生成中…', () => api(`/api/listening/doc/${docId}/manual`, { method: 'POST', body: { text: new FormData(event.currentTarget).get('text') } }));
      if (result) listeningView(view, { docId });
    });
    return;
  }
  let stopAt = null;
  audio.addEventListener('timeupdate', () => { if (stopAt != null && audio.currentTime >= stopAt) { audio.pause(); stopAt = null; } });
  const norm = (value) => String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const check = (index) => {
    const segment = item.segments[index];
    const row = $(`[data-seg="${index}"]`, view);
    let correct = 0;
    $$('[data-blank]', row).forEach((input) => {
      const expected = segment.cloze.answers[Number(input.dataset.blank)];
      const ok = norm(input.value) === norm(expected);
      input.classList.toggle('right', ok);
      input.classList.toggle('wrong', !ok);
      if (!ok) input.title = expected;
      if (ok) correct += 1;
    });
    row.classList.add('checked');
    return { correct, total: segment.cloze.answers.length };
  };
  const onClick = (event) => {
    const play = event.target.closest('[data-play]');
    if (play) {
      const segment = item.segments[Number(play.dataset.play)];
      audio.currentTime = segment.start;
      stopAt = segment.end + 0.15;
      audio.play();
    }
    const checkButton = event.target.closest('[data-check]');
    if (checkButton) {
      const { correct, total } = check(Number(checkButton.dataset.check));
      if (correct < total) toast(`本句 ${correct}/${total}，鼠标悬停红框可看答案`);
    }
  };
  delegate(view, onClick);
  $('#finish', view).addEventListener('click', async (event) => {
    let correct = 0;
    let total = 0;
    item.segments.forEach((_, index) => { const r = check(index); correct += r.correct; total += r.total; });
    const result = await busy(event.currentTarget, '提交中…', () => api(`/api/listening/items/${item.id}/attempt`, { method: 'POST', body: { correct, total } }));
    if (result) toast(result.summary);
  });
  $('#redo', view).addEventListener('click', () => {
    if (confirm('重新准备会覆盖当前原文与挖空，继续？')) {
      view.querySelector('.segments')?.remove();
      api(`/api/listening/doc/${docId}/transcribe`, { method: 'POST' }).then(() => listeningView(view, { docId })).catch((e) => toast(e.message, 'error'));
      toast('重新转写中…');
    }
  });
  setViewContext(`精听：${doc.title}\n原文：${item.segments.map((s) => s.text).join(' ').slice(0, 4000)}`);
}

// —— 口语素材 ——
export async function storiesView(view) {
  const stories = await api('/api/stories');
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <h1>口语素材</h1>
    <p class="muted">写下你真实的经历和故事（中英文都行），老师帮你匹配最相关的口语题目，并补充地道的英式表达。</p>
    <form class="card form" id="add"><input name="title" placeholder="标题，例如：和朋友一起完成的一个项目" required><div class="answer-box"><textarea name="story" rows="5" placeholder="经历细节：时间、地点、人物、发生了什么、你的感受（可点 🎙️ 直接讲）" required></textarea></div><button class="btn" type="submit">保存素材</button></form>
    ${stories.map((s) => html`<section class="card story" data-id="${s.id}">
      <div class="row between"><h2>${s.title}</h2><div class="row"><button class="btn ghost small" type="button" data-analyze="${s.id}">${s.analysis ? '重新匹配' : '匹配题目'}</button><button class="icon-btn" type="button" data-del="${s.id}" aria-label="删除">✕</button></div></div>
      <p class="pre">${s.story}</p>
      ${s.analysis ? html`<h3>可用题目</h3><ul>${(s.analysis.topics || []).map((t) => html`<li><span class="pill">${String(t.part).replace('part', 'Part ')}</span> <b>${t.topic}</b><p class="muted">${t.howToUse}</p></li>`)}</ul>
        <h3>表达</h3><ul>${(s.analysis.expressions || []).map((e) => html`<li><b>${e.en}</b> ${e.zh}${e.note ? html` <span class="muted">· ${e.note}</span>` : ''}</li>`)}</ul>
        ${s.analysis.outline ? html`<h3>Part 2 提纲</h3><div class="essay">${s.analysis.outline}</div>` : ''}` : ''}
    </section>`)}
  </div>`.value;
  const storyBox = $('#add .answer-box', view);
  storyBox.append(micButton($('textarea', storyBox), { lang: 'auto' }));
  $('#add', view).addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const result = await busy(event.submitter, '保存中…', () => api('/api/stories', { method: 'POST', body }));
    if (result) storiesView(view);
  });
  $$('[data-analyze]', view).forEach((button) => button.addEventListener('click', async () => {
    const result = await busy(button, '老师匹配中…', () => api(`/api/stories/${button.dataset.analyze}/analyze`, { method: 'POST' }));
    if (result) storiesView(view);
  }));
  $$('[data-del]', view).forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除这条素材？')) return;
    await api(`/api/stories/${button.dataset.del}`, { method: 'DELETE' });
    storiesView(view);
  }));
  setViewContext(`口语素材：${stories.map((s) => s.title).join('；')}`);
}
