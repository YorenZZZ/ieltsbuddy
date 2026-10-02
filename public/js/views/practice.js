import { api, html, raw, esc, band, busy, toast, skillNames, skillIcons, setViewContext, startTimer, cleanup, $, $$ } from '../core.js';
import { chartSvg } from '../chart.js';
import { micButton, micSupported } from '../mic.js';


const generating = '老师出题中…约 1–2 分钟';

async function createTask(button, body) {
  const result = await busy(button, generating, () => api('/api/tasks', { method: 'POST', body }));
  if (result) location.hash = `#/task/${result.id}`;
}

export async function drillView(view, { skill }) {
  const [overview, recent] = await Promise.all([api('/api/overview'), api(`/api/tasks?skill=${skill}`)]);
  const types = overview.catalog[skill] || [];
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <div class="tabs">${Object.keys(skillNames).map((s) => html`<a href="#/drill/${s}" class="${s === skill ? 'active' : ''}">${skillIcons[s]} ${skillNames[s]}</a>`)}</div>
    <h1>我要刷题 · ${skillNames[skill]}</h1>
    <label class="topic">指定话题（可选）<input id="topic" placeholder="例如：环境保护、科技与教育；留空由老师按薄弱项选"></label>
    <div class="type-grid">${types.map((t) => html`<button class="type-card" type="button" data-type="${t.type}"><b>${t.label}</b><span>${t.desc}</span><small>约 ${t.minutes} 分钟</small></button>`)}</div>
    <h2 class="section-title">最近${skillNames[skill]}练习</h2>
    ${recent.length ? html`<ul class="list">${recent.map((t) => html`<li><a href="#/task/${t.id}">${t.typeLabel} · ${t.title}</a><span class="muted">${t.createdAt.slice(0, 10)}</span><b>${t.status === 'graded' ? band(t.band) : '未提交'}</b></li>`)}</ul>` : html`<p class="muted">还没有练习。</p>`}
  </div>`.value;
  $$('[data-type]', view).forEach((button) => button.addEventListener('click', () => createTask(button, { skill, type: button.dataset.type, topic: $('#topic', view).value })));
  setViewContext(`刷题页：${skillNames[skill]}；最近 ${recent.slice(0, 5).map((t) => `${t.typeLabel} ${t.status === 'graded' ? band(t.band) : '未提交'}`).join('；')}`);
}

// —— 题目表单 ——
const optionToken = (option) => (/^([A-Za-z]{1,2}|[ivxlcdm]+)[\s.)]/i.exec(String(option))?.[1] ?? String(option));
const choiceSets = { tfng: ['TRUE', 'FALSE', 'NOT GIVEN'], ynng: ['YES', 'NO', 'NOT GIVEN'] };

function questionInput(q, value, disabled) {
  const name = `q-${q.id}`;
  const dis = disabled ? raw('disabled') : '';
  const choices = choiceSets[q.type] || (q.type === 'mcq' ? q.options || [] : null);
  if (choices) {
    return html`<div class="choices">${choices.map((option) => {
      const token = choiceSets[q.type] ? option : optionToken(option);
      return html`<label class="choice"><input type="radio" name="${name}" value="${token}" ${String(value) === token ? raw('checked') : ''} ${dis}><span>${option}</span></label>`;
    })}</div>`;
  }
  if (['heading', 'matching'].includes(q.type) && q.options?.length) {
    return html`<select name="${name}" ${dis}><option value="">选择</option>${q.options.map((option) => html`<option value="${optionToken(option)}" ${String(value) === optionToken(option) ? raw('selected') : ''}>${option}</option>`)}</select>`;
  }
  return html`<input type="text" name="${name}" value="${value || ''}" autocomplete="off" spellcheck="false" ${dis}>`;
}

function questionsBlock(task) {
  const graded = task.status === 'graded';
  const items = Object.fromEntries((task.result?.items || []).map((item) => [item.id, item]));
  const explanations = task.answerKey?.explanations || {};
  return html`<ol class="questions">${task.payload.questions.map((q) => {
    const item = items[q.id];
    return html`<li class="${item ? (item.correct ? 'right' : 'wrong') : ''}">
      <div class="q-prompt"><b>${q.id}.</b> ${q.prompt}</div>
      ${questionInput(q, task.answer?.[q.id], graded)}
      ${item ? html`<div class="q-key">${item.correct ? '✓ 正确' : `✗ 正确答案：${item.accepted.join(' / ')}`}${explanations[q.id] ? html`<p>${explanations[q.id]}</p>` : ''}</div>` : ''}
    </li>`;
  })}</ol>`;
}

const collectAnswers = (form, questions) => Object.fromEntries(questions.map((q) => {
  const checked = form.querySelector(`[name="q-${q.id}"]:checked`);
  const field = form.querySelector(`[name="q-${q.id}"]:not([type="radio"])`);
  return [q.id, checked ? checked.value : field ? field.value.trim() : ''];
}));

// —— 听力朗读（浏览器英音语音） ——
function ttsPlayer(container, script) {
  const synth = window.speechSynthesis;
  if (!synth) { container.innerHTML = '<p class="muted">此浏览器不支持语音朗读。</p>'; return; }
  let voices = [];
  const loadVoices = () => { voices = synth.getVoices(); };
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
  const pick = (gender) => {
    const british = voices.filter((v) => /en[-_]GB/i.test(v.lang));
    const pool = british.length ? british : voices.filter((v) => /^en/i.test(v.lang));
    const female = /female|serena|kate|martha|stephanie|libby|sonia|hazel|susan|fiona|emily/i;
    const male = /male|daniel|arthur|oliver|ryan|george|thomas|james/i;
    return pool.find((v) => (gender === 'male' ? male.test(v.name) && !/female/i.test(v.name) : female.test(v.name))) || pool[0] || null;
  };
  let index = 0;
  let playing = false;
  container.innerHTML = '<div class="row"><button class="btn" type="button" data-play>▶ 播放录音</button><button class="btn ghost" type="button" data-stop>■ 停止</button><span class="muted small" data-progress></span></div><p class="muted small">使用浏览器英式英语语音朗读；考试模式建议只听一遍。</p>';
  const progress = $('[data-progress]', container);
  const speakNext = () => {
    if (!playing || index >= script.length) { playing = false; progress.textContent = index >= script.length ? '播放完毕' : ''; return; }
    const line = script[index];
    const utterance = new SpeechSynthesisUtterance(line.text);
    utterance.voice = pick(line.voice);
    utterance.lang = 'en-GB';
    utterance.rate = 0.95;
    utterance.onend = () => { index += 1; speakNext(); };
    progress.textContent = `${index + 1}/${script.length}`;
    synth.speak(utterance);
  };
  $('[data-play]', container).addEventListener('click', () => { synth.cancel(); index = 0; playing = true; speakNext(); });
  $('[data-stop]', container).addEventListener('click', () => { playing = false; synth.cancel(); });
  cleanup.add(() => { playing = false; synth.cancel(); });
}

// —— 主观题批改结果 ——
function resultBlock(task) {
  const r = task.result;
  if (!r) return '';
  if (task.skill === 'listening' || task.skill === 'reading') {
    return html`<section class="card result"><div class="band-big">${band(r.overall)}</div><p>${r.summary}</p></section>`;
  }
  const criteria = Object.entries(r.criteria || {});
  return html`<section class="card result">
    <div class="row"><div class="band-big">${band(r.overall)}</div><p>${r.summary}${r.wordCount ? `（${r.wordCount} 词）` : ''}</p></div>
    <div class="criteria">${criteria.map(([name, c]) => html`<div><b>${name}</b><span class="band-chip">${c.band == null ? 'N/A' : band(c.band)}</span><p>${c.comment}</p></div>`)}</div>
    ${r.strengths?.length ? html`<h3>做得好的</h3><ul>${r.strengths.map((s) => html`<li>${s}</li>`)}</ul>` : ''}
    ${r.issues?.length ? html`<h3>问题与改法</h3><ul class="issues">${r.issues.map((i) => html`<li><q>${i.quote}</q><p>${i.problem}</p><p class="fix">→ ${i.fix}</p></li>`)}</ul>` : ''}
    ${r.perQuestion?.length ? html`<h3>逐题点评</h3><ul class="issues">${r.perQuestion.map((p) => html`<li><b>Q${p.id}</b><p>${p.feedback}</p><p class="fix">${p.better}</p></li>`)}</ul>` : ''}
    ${r.improved ? html`<h3>8.5 分改写</h3><div class="essay">${r.improved}</div>` : ''}
    ${r.vocab?.length ? html`<h3>值得收进生词本</h3><div class="vocab-chips">${r.vocab.map((v) => html`<span title="${v.example || ''}"><b>${v.word}</b> ${v.meaning}</span>`)}</div><button class="btn ghost small" type="button" data-save-vocab>全部加入生词本</button>` : ''}
    ${r.nextFocus ? html`<p class="focus">🎯 下一步：${r.nextFocus}</p>` : ''}
  </section>`;
}

function contextFor(task) {
  const head = `当前练习：${skillNames[task.skill]} ${task.typeLabel}「${task.title}」，状态 ${task.status === 'graded' ? `已批改，估分 ${band(task.band)}` : '作答中'}。`;
  if (task.status !== 'graded') return `${head}\n题目：${JSON.stringify(task.payload).slice(0, 3000)}`;
  return `${head}\n作答：${JSON.stringify(task.answer).slice(0, 2500)}\n批改：${JSON.stringify(task.result).slice(0, 3000)}`;
}

export async function taskView(view, { id }) {
  view._taskDraftCleanup?.();
  const task = await api(`/api/tasks/${id}`);
  const p = task.payload;
  const graded = task.status === 'graded';
  const back = task.mockId ? `#/mock/${task.mockId}` : `#/drill/${task.skill}`;
  const minutes = { listening: 10, reading: 20, writing: task.type === 'task1' ? 20 : 40, speaking: task.type === 'part2' ? 4 : 5 }[task.skill];
  let body = '';
  if (task.skill === 'listening') {
    body = html`<section class="card"><div id="tts"></div>${p.instructions ? html`<p class="instructions">${p.instructions}</p>` : ''}</section>
      <form id="answer-form" class="card">${questionsBlock(task)}${graded ? '' : html`<button class="btn" type="submit">提交判分</button>`}</form>
      ${graded ? html`<details class="card"><summary>录音原文</summary>${(p.script || []).map((line) => html`<p><b>${line.speaker}：</b>${line.text}</p>`)}</details>` : ''}`;
  } else if (task.skill === 'reading') {
    body = html`<div class="split">
      <article class="card passage scroll"><h2>${p.title}</h2>${(p.passage || []).map((para) => html`<p><b class="para">${para.label}</b> ${para.text}</p>`)}</article>
      <form id="answer-form" class="card scroll">${questionsBlock(task)}${graded ? '' : html`<button class="btn" type="submit">提交判分</button>`}</form></div>`;
  } else if (task.skill === 'writing') {
    body = html`<section class="card prompt"><p>${p.title}</p>${raw(chartSvg(p.chart))}</section>
      <form id="answer-form" class="card">
        <textarea name="essay" id="essay" rows="16" spellcheck="false" placeholder="在这里写作文…" ${graded ? raw('disabled') : ''}>${task.answer?.essay || ''}</textarea>
        <div class="row between"><span class="muted small" id="word-count"></span>${graded ? '' : html`<button class="btn" type="submit">提交批改</button>`}</div>
      </form>`;
  } else {
    body = html`${p.cueCard ? html`<section class="card cue"><h3>${p.cueCard.topic}</h3><p>You should say:</p><ul>${(p.cueCard.points || []).map((pt) => html`<li>${pt}</li>`)}</ul><p>${p.cueCard.ending}</p>${graded ? '' : html`<p class="muted small">先用 1 分钟列要点，再按 2 分钟的量作答。</p>`}</section>` : ''}
      <form id="answer-form" class="card"><ol class="questions">${p.questions.map((q) => html`<li><div class="q-prompt">${q.prompt}</div><div class="answer-box" data-q="${q.id}"><textarea name="q-${q.id}" rows="${p.cueCard && q.id === '1' ? 9 : 4}" placeholder="${micSupported() ? '点 🎙️ 开口作答，转写后可再修改；也可以直接打字' : '用英文作答，像平时说话一样'}" ${graded ? raw('disabled') : ''}>${task.answer?.[q.id] || ''}</textarea></div>
        ${(task.answer?._audio?.[q.id]?.recordings || []).map((id) => html`<audio controls preload="none" src="/api/recordings/${id}"></audio>`)}</li>`)}</ol>
      ${graded ? '' : html`<p class="muted small">${micSupported() ? '录音经 Groq 转成文字后交给考官；会保存录音，批改后可回放自查发音。' : '当前不是 HTTPS 访问，浏览器不允许麦克风，先用文字作答；经 Lucky 域名访问即可录音。'}</p><button class="btn" type="submit">提交批改</button>`}</form>`;
  }
  view.innerHTML = html`<div class="page wide">
    <div class="row between"><a class="back" href="${back}">← 返回</a>${graded ? '' : html`<span class="timer" id="timer"></span>`}</div>
    <h1>${skillIcons[task.skill]} ${task.skill === 'writing' ? task.typeLabel : task.title}</h1>
    <p class="muted">${skillNames[task.skill]} · ${task.typeLabel}${graded ? ` · 估分 ${band(task.band)}` : ''}</p>
    ${graded ? resultBlock(task) : ''}
    ${body}
  </div>`.value;
  setViewContext(contextFor(task));
  if (!graded) startTimer($('#timer', view), minutes);
  if (task.skill === 'listening' && $('#tts', view)) ttsPlayer($('#tts', view), p.script || []);
  const essay = $('#essay', view);
  if (essay) {
    const count = () => { $('#word-count', view).textContent = `${(essay.value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length} 词`; };
    essay.addEventListener('input', count);
    count();
  }
  $('[data-save-vocab]', view)?.addEventListener('click', async (event) => {
    const result = await busy(event.currentTarget, '加入中…', () => api('/api/vocab/batch', { method: 'POST', body: { words: task.result.vocab, source: `批改：${task.title}` } }));
    if (result) toast(`已加入 ${result.added} 个新词`);
  });
  const form = $('#answer-form', view);
  // 口语录音：每题累计时长与录音编号，随作答提交（考官据此估算语速，批改页可回放）。
  const audio = task.answer?._audio || {};
  if (!graded && task.skill === 'speaking') {
    $$('.answer-box', view).forEach((box) => {
      const id = box.dataset.q;
      const prompt = [p.cueCard?.topic, p.questions.find((q) => q.id === id)?.prompt].filter(Boolean).join(' ');
      box.append(micButton($('textarea', box), { lang: 'en', keep: true, prompt, onResult: ({ duration, recordingId }) => {
        const entry = audio[id] || (audio[id] = { duration: 0, recordings: [] });
        entry.duration += Number(duration) || 0;
        if (recordingId) entry.recordings.push(recordingId);
        form.dispatchEvent(new Event('input', { bubbles: true }));
      } }));
    });
  }
  if (!graded && form) {
    const collect = () => task.skill === 'writing' ? { essay: essay.value } : task.skill === 'speaking'
      ? { ...Object.fromEntries(p.questions.map((q) => [q.id, form.querySelector(`[name="q-${q.id}"]`).value.trim()])), ...(Object.keys(audio).length ? { _audio: audio } : {}) }
      : collectAnswers(form, p.questions);
    const note = document.createElement('p'); note.className = 'muted small'; note.textContent = '作答会自动保存到项目中'; form.append(note);
    let timer; let dirty = false; let submitted = false; let pending = Promise.resolve();
    const save = (keepalive = false) => {
      clearTimeout(timer);
      if (!dirty || submitted) return pending;
      dirty = false;
      const answer = collect();
      pending = pending.catch(() => {}).then(() => api(`/api/tasks/${task.id}/draft`, { method: 'PUT', body: { answer }, keepalive })).then(() => { if (note.isConnected) note.textContent = '作答已保存'; }).catch((error) => { dirty = true; if (note.isConnected) note.textContent = `草稿未保存：${error.message}`; });
      return pending;
    };
    const changed = () => { dirty = true; note.textContent = '正在保存…'; clearTimeout(timer); timer = setTimeout(save, 800); };
    form.addEventListener('input', changed); form.addEventListener('change', changed);
    const leaving = () => save(true);
    window.addEventListener('pagehide', leaving);
    const release = () => { save(true); clearTimeout(timer); window.removeEventListener('pagehide', leaving); cleanup.delete(release); };
    cleanup.add(release); view._taskDraftCleanup = release;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await save();
      const answer = collect();
      const label = ['writing', 'speaking'].includes(task.skill) ? '考官批改中…约 1 分钟' : '判分中…';
      const result = await busy(event.submitter, label, () => api(`/api/tasks/${task.id}/submit`, { method: 'POST', body: { answer } }));
      if (result) { submitted = true; taskView(view, { id }); }
    });
  }
}

export async function mockListView(view) {
  const mocks = await api('/api/mocks');
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <h1>做模考</h1>
    <p class="muted">完整四科：听力 4 个 Section、阅读 3 篇、写作 2 篇、口语 3 个 Part。每一部分在进入时由老师现场出题，全部完成后给出总分。</p>
    <button class="btn" id="new-mock" type="button">开始新模考</button>
    <ul class="list">${mocks.map((m) => html`<li><a href="#/mock/${m.id}">模考 #${m.id}</a><span class="muted">${m.started_at.slice(0, 16)}</span><b>${m.status === 'finished' ? `总分 ${band(m.overall)}` : '进行中'}</b></li>`)}</ul>
  </div>`.value;
  $('#new-mock', view).addEventListener('click', async (event) => {
    const result = await busy(event.currentTarget, '创建中…', () => api('/api/mocks', { method: 'POST' }));
    if (result) location.hash = `#/mock/${result.id}`;
  });
}

export async function mockView(view, { id }) {
  const mock = await api(`/api/mocks/${id}`);
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/mock">← 模考列表</a>
    <h1>模考 #${mock.id}</h1>
    <div class="stats">${['listening', 'reading', 'writing', 'speaking'].map((s) => html`<div><b>${band(mock.scores[s])}</b><span>${skillNames[s]}</span></div>`)}<div class="overall"><b>${band(mock.scores.overall)}</b><span>总分</span></div></div>
    ${['listening', 'reading', 'writing', 'speaking'].map((skill) => html`<section class="card"><h2>${skillIcons[skill]} ${skillNames[skill]}</h2>
      <ul class="list">${mock.sections.map((s, index) => (s.skill === skill ? html`<li><span>${s.label}</span><b>${s.status === 'graded' ? band(s.band) : s.status === 'open' ? '作答中' : '未开始'}</b><button class="btn ghost small" type="button" data-section="${index}">${s.status === 'pending' ? '开始' : s.status === 'graded' ? '查看' : '继续'}</button></li>` : ''))}</ul></section>`)}
  </div>`.value;
  $$('[data-section]', view).forEach((button) => button.addEventListener('click', async () => {
    const result = await busy(button, generating, () => api(`/api/mocks/${id}/sections/${button.dataset.section}`, { method: 'POST' }));
    if (result) location.hash = `#/task/${result.taskId}`;
  }));
  setViewContext(`模考 #${mock.id}：${JSON.stringify(mock.scores)}`);
}

export async function predictView(view) {
  const prediction = await api('/api/predict');
  const practise = (skill, type, content) => html`<button class="btn ghost small" type="button" data-practise='${JSON.stringify({ skill, type, content })}'>去练</button>`;
  view.innerHTML = html`<div class="page">
    <a class="back" href="#/">← 技能工具箱</a>
    <div class="row between"><h1>预测命中</h1><button class="btn" id="gen" type="button">${prediction ? '重新预测' : '生成本季预测'}</button></div>
    <p class="muted">老师结合 NAS 资料中的题库 / 机经与近年高频规律给出话题，不是官方预测。</p>
    ${prediction ? html`
      <section class="card"><h2>依据</h2><p>${prediction.basis}</p><p class="muted small">生成于 ${prediction.generatedAt?.slice(0, 16).replace('T', ' ')}${prediction.sources?.length ? ` · 参考：${prediction.sources.map((s) => `《${s.title}》`).join(' ')}` : ''}</p></section>
      <section class="card"><h2>口语</h2><ul class="predict-list">${(prediction.speaking || []).map((item) => html`<li><div><span class="pill">${String(item.part).replace('part', 'Part ')}</span> <b>${item.cueCard?.topic || item.topic}</b>
        ${item.questions?.length ? html`<ul>${item.questions.map((q) => html`<li>${q}</li>`)}</ul>` : ''}${item.cueCard?.points?.length ? html`<ul>${item.cueCard.points.map((pt) => html`<li>${pt}</li>`)}</ul>` : ''}</div>${practise('speaking', item.part, item)}</li>`)}</ul></section>
      <section class="card"><h2>写作</h2><ul class="predict-list">${(prediction.writing || []).map((item) => html`<li><div><span class="pill">${item.essayType || 'Task 2'}</span> ${item.title}</div>${practise('writing', 'task2', item)}</li>`)}</ul></section>`
    : html`<div class="empty">还没有预测，点右上角生成。</div>`}
  </div>`.value;
  $('#gen', view).addEventListener('click', async (event) => {
    const result = await busy(event.currentTarget, '老师分析题库中…约 1 分钟', () => api('/api/predict', { method: 'POST' }));
    if (result) predictView(view);
  });
  $$('[data-practise]', view).forEach((button) => button.addEventListener('click', async () => {
    const result = await busy(button, '建题中…', () => api('/api/tasks/custom', { method: 'POST', body: JSON.parse(button.dataset.practise) }));
    if (result) location.hash = `#/task/${result.id}`;
  }));
  if (prediction) setViewContext(`预测命中：${JSON.stringify(prediction).slice(0, 3000)}`);
}
