import { api, html, skillNames, skillIcons, requireLogin, $$ } from '../core.js';

const modules = [
  ['mock', '⏱️', '做模考', '按四科进行完整模拟考试，分项练习与总分记录会保存在项目中。', '开始新模考'],
  ['course', '📘', '学课程', '选择听说读写课程主题，老师讲解后可以继续追问。', '开始学习'],
  ['predict', '📰', '预测命中', '结合备考方向和当前话题生成练习建议与训练题目。', '生成预测'],
  ['library', '☁️', '云盘', '扫描、搜索并预览 NAS 挂载的学习资料，供老师引用。', '扫描资料库'],
  ['news', '📰', '雅思备考资讯', '检索备考方法、考试政策、留学申请与院校信息。', '开始检索'],
  ['vocab', '📖', '词汇', '添加个人生词、生成话题词汇并按间隔重复复习。', '开始学习词汇'],
  ['listening', '🎧', '听力精听', '将资料库音频转写或导入原文，进行按句挖空训练。', '开始精听'],
  ['stories', '🎙️', '口语素材', '保存自己的经历和故事，让老师分析可适配的口语题目。', '添加口语素材'],
  ['plan', '🗓️', '学习计划', '老师结合学员档案和最近练习编排今日训练，记录完成进度。', '编排今日训练'],
  ['history', '📍', '我的足迹', '查看自己的练习、课程、模考记录和成绩趋势。登录后可查看个人历史。', '查看我的记录'],
];
export async function guestView(view, path, params) {
  if (path === '/settings') {
    view.innerHTML = html`<div class="page narrow"><div class="empty"><h1>请先登录</h1><p>登录后才能查看和修改设置。</p><button class="btn" data-login type="button">登录</button></div></div>`.value;
  } else {
    const { catalog, courseTopics } = await api('/api/public/catalog');
    let content;
    if (path === '/') {
      content = html`<h1>你的雅思学习伙伴</h1><p class="muted">先浏览各个模块，开始练习时再登录。</p>
        <h2 class="section-title">我要刷题</h2><div class="home-grid">${Object.entries(skillNames).map(([skill, label]) => html`<a class="module" href="#/drill/${skill}"><span class="module-icon violet">${skillIcons[skill]}</span><div><h3>${label}</h3><p>浏览题型与训练时长</p></div></a>`)}</div>
        <h2 class="section-title">学习模块</h2><div class="modules">${modules.map(([route, icon, title, desc]) => html`<a class="module" href="#/${route}"><span class="module-icon lime">${icon}</span><div><h3>${title}</h3><p>${desc}</p></div></a>`)}</div>`;
    } else if (path.startsWith('/drill/')) {
      const skill = params.skill;
      content = html`<a class="back" href="#/">← 技能工具箱</a><h1>我要刷题 · ${skillNames[skill] || '未知技能'}</h1>
        <div class="tabs">${Object.entries(skillNames).map(([key, label]) => html`<a href="#/drill/${key}" class="${key === skill ? 'active' : ''}">${skillIcons[key]} ${label}</a>`)}</div>
        <div class="type-grid">${(catalog[skill] || []).map((item) => html`<button class="type-card" data-login type="button"><b>${item.label}</b><span>${item.desc}</span><small>约 ${item.minutes} 分钟 · 登录后出题</small></button>`)}</div>`;
    } else {
      const module = modules.find(([key]) => path === `/${key}` || path.startsWith(`/${key}/`));
      const [, icon, title, desc, action] = module || ['', '🔒', '个人学习内容', '登录后查看自己的学习记录。', '登录查看'];
      content = html`<a class="back" href="#/">← 技能工具箱</a><h1>${icon} ${title}</h1><section class="card"><p>${desc}</p>
        ${path.startsWith('/course') ? html`<div class="tabs">${Object.entries(skillNames).map(([key, label]) => html`<a href="#/course/${key}" class="${key === (params.skill || 'writing') ? 'active' : ''}">${label}</a>`)}</div><div class="chips-row">${(courseTopics[params.skill || 'writing'] || []).map((topic) => html`<button class="chip" data-login type="button">${topic}</button>`)}</div>` : ''}
        <button class="btn" data-login type="button">${action}</button></section>`;
    }
    view.innerHTML = html`<div class="page">${content}<p class="muted small guest-note">个人资料和历史仅登录后可见。</p></div>`.value;
  }
  $$('[data-login]', view).forEach((button) => button.addEventListener('click', requireLogin));
}
