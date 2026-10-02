// 出题与批改。题目生成与主观题批改调用 HolySheep；听力、阅读按答案键确定性判分。
import { chatJson, chatCompletion } from './llm.mjs';
import { parseJson } from './db.mjs';
import { rawToBand, roundBand, scoreObjective } from './band.mjs';
import { libraryContext, profileText, snapshotText, learnerSnapshot, skillNames, examCountdown } from './tutor.mjs';
import { planSummary } from './plan.mjs';
import { httpError, todayKey } from './util.mjs';

export const catalog = {
  listening: [
    { type: 'section1', label: 'Section 1 · 生活对话', minutes: 8, desc: '两人就生活场景交流（订房、报名、咨询）' },
    { type: 'section2', label: 'Section 2 · 生活独白', minutes: 8, desc: '一人介绍场地、活动或服务' },
    { type: 'section3', label: 'Section 3 · 学术讨论', minutes: 9, desc: '2–4 人讨论作业、研究或课程' },
    { type: 'section4', label: 'Section 4 · 学术讲座', minutes: 9, desc: '一人讲一个学术主题' },
  ],
  reading: [
    { type: 'passage1', label: 'Passage 1 · 入门难度', minutes: 20, desc: '事实性说明文' },
    { type: 'passage2', label: 'Passage 2 · 中等难度', minutes: 20, desc: '论述与研究介绍' },
    { type: 'passage3', label: 'Passage 3 · 高难度', minutes: 20, desc: '观点密集的学术议论文' },
  ],
  writing: [
    { type: 'task1', label: 'Task 1 · 图表描述', minutes: 20, desc: '柱状图 / 折线图 / 饼图 / 表格，150 词以上' },
    { type: 'task2', label: 'Task 2 · 议论文', minutes: 40, desc: '观点、讨论、问题解决等，250 词以上' },
  ],
  speaking: [
    { type: 'part1', label: 'Part 1 · 简单对话', minutes: 5, desc: '日常话题 5–6 问' },
    { type: 'part2', label: 'Part 2 · 卡片陈述', minutes: 4, desc: '准备 1 分钟，陈述 2 分钟' },
    { type: 'part3', label: 'Part 3 · 深入讨论', minutes: 5, desc: '抽象延伸讨论' },
  ],
};

export const typeLabel = (skill, type) => catalog[skill]?.find((item) => item.type === type)?.label || type;

const listeningSpecs = {
  section1: '学术类听力 Section 1：两人（一男一女）在日常社交场景中的对话，例如预订、报名、咨询；以表格/笔记填空为主',
  section2: '学术类听力 Section 2：一人在日常社交场景中的独白，例如介绍设施、活动安排；可含地图/平面图题（用文字描述位置并给出 A–H 选项）与单选',
  section3: '学术类听力 Section 3：2–4 人在教育场景中的讨论，例如学生与导师讨论作业；以单选、多选、匹配为主',
  section4: '学术类听力 Section 4：一位讲者的学术讲座独白；以笔记/摘要填空为主',
};
const readingSpecs = {
  passage1: '难度对应剑桥真题 Passage 1，事实性说明文',
  passage2: '难度对应剑桥真题 Passage 2，含研究介绍与不同观点',
  passage3: '难度对应剑桥真题 Passage 3，观点密集、词汇与句式最难',
};

const jsonOnly = '只输出一个 JSON 对象，不要 Markdown 代码块和任何其他文字。';

function generationPrompt(skill, type, ctx, topicHint = '') {
  const header = `${profileText(ctx.profile)}\n${snapshotText(ctx.snapshot)}\n请结合学员水平与薄弱项出题，题目质量对标剑桥雅思真题；英文统一英式拼写。${topicHint ? `\n话题要求：${topicHint}` : ''}`;
  if (skill === 'listening') {
    return `${header}\n请原创一套${listeningSpecs[type]}。要求：
- script：完整录音稿数组，每项 {"speaker":"人物名","voice":"female|male","text":"一轮话语"}，共 600–800 词，自然口语，包含真题常见干扰（改口、数字更正、拼写名字、先否定后肯定）。
- questions：恰好 10 题，id 为 "1"–"10"。每项 {"id","type":"completion|mcq","prompt":"题干（填空处用 ____ 表示）","options":["A ...","B ...","C ..."]（仅 mcq）}。
- instructions：答题说明（如 Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer）。
- answers：{"1":["标准答案","可接受变体"]}，单选填选项字母。
- explanations：{"1":"中文：原文定位与考点"}。
输出 {"title","instructions","script","questions","answers","explanations"}。${jsonOnly}`;
  }
  if (skill === 'reading') {
    return `${header}\n请原创一篇雅思学术类阅读（${readingSpecs[type]}）：800–950 词，段落以 A、B、C… 标注。
出 13 题，混合 2–3 种题型：tfng（TRUE/FALSE/NOT GIVEN）、ynng（YES/NO/NOT GIVEN）、heading（段落标题匹配，options 为罗马数字标题列表）、matching（信息所在段落，options 为段落字母）、mcq（单选，options 为 "A ..."）、completion（句子/摘要填空，prompt 注明字数限制）。
每题 {"id":"1"…"13","type","prompt","options"(需要时)}；answers 为 {"1":["TRUE"]}（heading 填罗马数字，matching 填段落字母，mcq 填字母）；explanations 为中文解析（定位段落 + 同义替换）。
输出 {"title","passage":[{"label":"A","text":"..."}],"questions","answers","explanations"}。${jsonOnly}`;
  }
  if (skill === 'writing' && type === 'task1') {
    return `${header}\n请出一道雅思学术类写作 Task 1，图表数据必须真实可信、可直接绘制，且有清晰可比的趋势或对比。
输出 {"title":"题目原文（英文，含 Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.）","chart":{"type":"bar|line|pie|table","title":"图表标题","unit":"单位","categories":["横轴或分类"],"series":[{"name":"系列名","values":[数字]}]}}。pie 只用一个系列。${jsonOnly}`;
  }
  if (skill === 'writing') {
    return `${header}\n请出一道雅思学术类写作 Task 2，选择对学员最有训练价值的题型。
输出 {"title":"题目原文（英文，结尾含 Give reasons for your answer and include any relevant examples from your own knowledge or experience. Write at least 250 words.）","essayType":"opinion|discussion|problem-solution|advantages-disadvantages|two-part"}。${jsonOnly}`;
  }
  if (type === 'part1') {
    return `${header}\n请出一组雅思口语 Part 1：1–2 个日常话题，共 6 个问题，像考官一样自然递进。
输出 {"title":"话题名","questions":[{"id":"1","prompt":"问题"}]}。${jsonOnly}`;
  }
  if (type === 'part2') {
    return `${header}\n请出一张雅思口语 Part 2 话题卡，并给出 2 个考官收尾追问。
输出 {"title":"Describe ...","cueCard":{"topic":"Describe ...","points":["who/what ...","..."],"ending":"and explain ..."},"questions":[{"id":"1","prompt":"（话题卡陈述，约 2 分钟）"},{"id":"2","prompt":"追问 1"},{"id":"3","prompt":"追问 2"}]}。${jsonOnly}`;
  }
  return `${header}\n请出一组雅思口语 Part 3：围绕一个主题的 5 个抽象讨论问题，由浅入深。
输出 {"title":"主题","questions":[{"id":"1","prompt":"问题"}]}。${jsonOnly}`;
}

function splitKey(data) {
  const { answers, explanations, ...payload } = data;
  return { payload, answerKey: answers ? { answers, explanations: explanations || {} } : null };
}

function normalizeQuestions(payload) {
  payload.questions = (payload.questions || []).map((q, index) => ({ ...q, id: String(q.id ?? index + 1) }));
  return payload;
}

export function insertTask(db, { kind, skill, type, payload, answerKey = null, mockId = null }) {
  const title = payload.title || typeLabel(skill, type);
  const { lastInsertRowid } = db.prepare('INSERT INTO tasks (kind, skill, type, title, payload, answer_key, mock_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(kind, skill, type, String(title).slice(0, 200), JSON.stringify(payload), answerKey ? JSON.stringify(answerKey) : null, mockId);
  return Number(lastInsertRowid);
}

export async function generateTask(ctx, skill, type, { kind = 'drill', mockId = null, topic = '' } = {}) {
  if (!catalog[skill]?.some((item) => item.type === type)) throw httpError(400, '未知题型');
  const data = await chatJson(ctx.llm, [
    { role: 'system', content: '你是剑桥雅思命题专家，严格按要求输出 JSON。' },
    { role: 'user', content: generationPrompt(skill, type, ctx, topic) },
  ], { maxTokens: 12000 });
  const { payload, answerKey } = splitKey(data);
  normalizeQuestions(payload);
  if (['listening', 'reading'].includes(skill) && (!answerKey || !payload.questions.length)) throw httpError(502, '模型返回的题目缺少答案，请重试');
  return insertTask(ctx.db, { kind, skill, type, payload, answerKey, mockId });
}

// 由预测话题等现成内容直接建题，不再调用模型。
export function customTask(db, { skill, type, content, kind = 'predict' }) {
  if (skill === 'writing') return insertTask(db, { kind, skill, type: 'task2', payload: { title: content.title, essayType: content.essayType || '' } });
  if (skill === 'speaking' && type === 'part2' && content.cueCard) {
    return insertTask(db, { kind, skill, type, payload: { title: content.cueCard.topic || content.topic, cueCard: content.cueCard, questions: [{ id: '1', prompt: '（话题卡陈述，约 2 分钟）' }] } });
  }
  if (skill === 'speaking') {
    return insertTask(db, { kind, skill, type, payload: { title: content.topic, questions: (content.questions || []).map((prompt, index) => ({ id: String(index + 1), prompt })) } });
  }
  throw httpError(400, '该内容无法直接建题');
}

export function publicTask(task) {
  const graded = task.status === 'graded';
  return {
    id: task.id, kind: task.kind, skill: task.skill, type: task.type, typeLabel: typeLabel(task.skill, task.type), title: task.title,
    status: task.status, band: task.band, mockId: task.mock_id, createdAt: task.created_at, gradedAt: task.graded_at,
    payload: parseJson(task.payload, {}), answer: parseJson(task.answer, null), result: parseJson(task.result, null),
    answerKey: graded ? parseJson(task.answer_key, null) : null,
  };
}

const wordCount = (text) => (String(text).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;

async function gradeWriting(ctx, task, payload, essay) {
  const criterion = task.type === 'task1' ? 'TA（Task Achievement）' : 'TR（Task Response）';
  const words = wordCount(essay);
  return chatJson(ctx.llm, [
    { role: 'system', content: '你是资深雅思写作考官，严格依据官方公开评分标准评分，不因鼓励而虚高。' },
    { role: 'user', content: `${profileText(ctx.profile)}
批改这篇雅思学术类写作 ${task.type === 'task1' ? 'Task 1' : 'Task 2'}。四项各 0–9 分（步长 0.5）：${criterion}、CC、LR、GRA；overall 按雅思规则取整。
字数 ${words}（${task.type === 'task1' ? '少于 150' : '少于 250'} 词需在 ${criterion.slice(0, 2)} 中扣分）。
题目：${payload.title}
${payload.chart ? `图表数据：${JSON.stringify(payload.chart)}` : ''}
作文：
${essay}

输出 {"overall":6.5,"criteria":{"${criterion.slice(0, 2)}":{"band":6.5,"comment":"中文"},"CC":{...},"LR":{...},"GRA":{...}},"summary":"中文总评 2–3 句","strengths":["..."],"issues":[{"quote":"原文片段","problem":"中文说明","fix":"改写"}],"improved":"保留原意、提升到 8.5 分水平的完整改写（英式拼写）","vocab":[{"word":"","meaning":"中文","example":""}],"nextFocus":"下一次最该练的一点（中文一句）"}。${jsonOnly}` },
  ], { maxTokens: 10000 });
}

// 麦克风作答附带录音时长（answers._audio），换算成语速给考官参考流利度。
export function speakingPace(text, audio) {
  if (!audio?.duration) return null;
  const words = (String(text || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  return { seconds: Math.round(audio.duration), wpm: Math.round((words / audio.duration) * 60) };
}

async function gradeSpeaking(ctx, task, payload, answers) {
  const audio = answers._audio || {};
  const qa = payload.questions.map((q) => {
    const pace = speakingPace(answers[q.id], audio[q.id]);
    return `Q${q.id}: ${q.prompt}\nA${q.id}${pace ? `（麦克风录音 ${pace.seconds} 秒，约 ${pace.wpm} 词/分钟）` : ''}: ${answers[q.id] || '（未作答）'}`;
  }).join('\n\n');
  const mode = Object.keys(audio).length
    ? '标注了录音时长的回答是麦克风录音经语音转写得到的（转写会抹掉停顿、重复和口音细节，语速可作 FC 参考；转写里明显不合语境的词可能是发音不清被听错）。仍无法可靠评估发音：P 项 band 给 null，comment 指出疑似发音问题并说明如何回放录音自查'
    : '学员以文字形式作答（无法评估发音：P 项 band 给 null 并说明如何自查）';
  return chatJson(ctx.llm, [
    { role: 'system', content: '你是资深雅思口语考官，严格依据官方公开评分标准评分。' },
    { role: 'user', content: `${profileText(ctx.profile)}
学员回答了雅思口语 ${task.type.replace('part', 'Part ')}。${mode}。按 FC、LR、GRA 各 0–9 分（步长 0.5），overall 为三项平均按雅思规则取整。
学员计划强调“说人话、不背模板”：背诵感强、假大空的回答要明确指出；表达建议优先英式用词。
${payload.cueCard ? `话题卡：${JSON.stringify(payload.cueCard)}\n` : ''}${qa}

输出 {"overall":6.5,"criteria":{"FC":{"band":6.5,"comment":"中文"},"LR":{...},"GRA":{...},"P":{"band":null,"comment":"中文"}},"summary":"中文总评","perQuestion":[{"id":"1","feedback":"中文点评","better":"更自然的 8 分版本（英文口语）"}],"vocab":[{"word":"","meaning":"中文","example":""}],"nextFocus":"下一次最该练的一点（中文一句）"}。${jsonOnly}` },
  ], { maxTokens: 10000 });
}

export async function gradeTask(ctx, task, answer) {
  const payload = parseJson(task.payload, {});
  let result;
  let band;
  if (task.skill === 'listening' || task.skill === 'reading') {
    const key = parseJson(task.answer_key, {});
    const score = scoreObjective(payload.questions, answer || {}, key.answers || {});
    band = rawToBand(score.correct, score.total, task.skill);
    result = { ...score, overall: band, summary: `答对 ${score.correct}/${score.total}，按 40 题比例折算估分 ${band}。` };
  } else if (task.skill === 'writing') {
    const essay = String(answer?.essay || '').trim();
    if (wordCount(essay) < 30) throw httpError(400, '作文太短，至少写 30 个词再提交');
    result = await gradeWriting(ctx, task, payload, essay);
    result.wordCount = wordCount(essay);
    band = Number(result.overall);
  } else {
    if (!Object.values(answer || {}).some((text) => String(text).trim())) throw httpError(400, '至少回答一题再提交');
    result = await gradeSpeaking(ctx, task, payload, answer);
    band = Number(result.overall);
  }
  if (!Number.isFinite(band)) band = null;
  ctx.db.prepare("UPDATE tasks SET status = 'graded', answer = ?, result = ?, band = ?, graded_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(JSON.stringify(answer), JSON.stringify(result), band, task.id);
  if (task.mock_id) finishMockIfComplete(ctx.db, task.mock_id);
}

// —— 模考：12 个分项按需生成，全部批改后计算总分 ——
export const mockSections = [
  ...['section1', 'section2', 'section3', 'section4'].map((type) => ({ skill: 'listening', type })),
  ...['passage1', 'passage2', 'passage3'].map((type) => ({ skill: 'reading', type })),
  { skill: 'writing', type: 'task1' }, { skill: 'writing', type: 'task2' },
  ...['part1', 'part2', 'part3'].map((type) => ({ skill: 'speaking', type })),
];

export function createMock(db) {
  const sections = mockSections.map((section) => ({ ...section, taskId: null }));
  return Number(db.prepare('INSERT INTO mocks (sections) VALUES (?)').run(JSON.stringify(sections)).lastInsertRowid);
}

export function mockScores(db, sections) {
  const tasks = sections.map((section) => (section.taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(section.taskId) : null));
  const graded = (skill) => tasks.filter((task, index) => sections[index].skill === skill && task?.status === 'graded');
  const objective = (skill, expected) => {
    const done = graded(skill);
    if (done.length < expected) return null;
    const results = done.map((task) => parseJson(task.result, {}));
    return rawToBand(results.reduce((sum, r) => sum + r.correct, 0), results.reduce((sum, r) => sum + r.total, 0), skill);
  };
  const writingTasks = graded('writing');
  const writing = writingTasks.length === 2
    ? roundBand((writingTasks.find((t) => t.type === 'task1').band + 2 * writingTasks.find((t) => t.type === 'task2').band) / 3)
    : null;
  const speakingTasks = graded('speaking');
  const speaking = speakingTasks.length === 3 ? roundBand(speakingTasks.reduce((sum, t) => sum + t.band, 0) / 3) : null;
  const scores = { listening: objective('listening', 4), reading: objective('reading', 3), writing, speaking };
  const all = Object.values(scores);
  return { ...scores, overall: all.every((value) => value != null) ? roundBand(all.reduce((a, b) => a + b, 0) / 4) : null };
}

function finishMockIfComplete(db, mockId) {
  const mock = db.prepare('SELECT * FROM mocks WHERE id = ?').get(mockId);
  if (!mock) return;
  const { overall } = mockScores(db, parseJson(mock.sections, []));
  if (overall != null) db.prepare("UPDATE mocks SET status = 'finished', overall = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(overall, mockId);
}

export async function ensureMockSection(ctx, mockId, index) {
  const mock = ctx.db.prepare('SELECT * FROM mocks WHERE id = ?').get(mockId);
  if (!mock) throw httpError(404, '模考不存在');
  const sections = parseJson(mock.sections, []);
  const section = sections[index];
  if (!section) throw httpError(404, '分项不存在');
  if (!section.taskId) {
    section.taskId = await generateTask(ctx, section.skill, section.type, { kind: 'mock', mockId });
    ctx.db.prepare('UPDATE mocks SET sections = ? WHERE id = ?').run(JSON.stringify(sections), mockId);
  }
  return section.taskId;
}

// —— 学课程 ——
export const courseTopics = {
  listening: ['数字、日期与拼写陷阱', '地图题方位表达', 'Section 3 多选题干扰项', '连读弱读导致的误听'],
  reading: ['TRUE / FALSE / NOT GIVEN 判断逻辑', '段落标题匹配的主旨句定位', '同义替换识别', '摘要填空的语法预判'],
  writing: ['Task 1 概述段与关键特征选择', 'Task 1 数据比较句型', 'Task 2 论点展开（PEEL）', '衔接手段与指代避免重复', '复杂句的准确使用'],
  speaking: ['Part 1 自然展开：理由 + 细节', 'Part 2 一分钟准备与故事线', 'Part 3 抽象观点的论证', '英音节奏：重音、弱读与 linking R'],
};

export async function generateLesson(ctx, skill, topic) {
  const library = libraryContext(ctx.db, `${skillNames[skill]} ${topic}`, 3);
  const markdown = await chatCompletion(ctx.llm, [
    { role: 'system', content: '你是学员的雅思一对一老师，讲解清楚、例子地道（英式），练习有梯度。' },
    { role: 'user', content: `${profileText(ctx.profile)}\n${snapshotText(ctx.snapshot)}
学员计划要点：\n${planSummary(ctx.plan)}
${library.text ? `\n可引用的学员资料片段（引用时注明《文件名》）：\n${library.text}\n` : ''}
请写一节雅思${skillNames[skill]}课，主题：${topic || '（请根据学员最近暴露的薄弱项自选最值得学的一个主题）'}。
用 Markdown，首行“# 课程标题”，然后依次：## 学习目标、## 核心讲解（中文讲解 + 英文例子）、## 常见错误、## 练习（5 题左右）、## 今天就用上（一个 10 分钟小任务）、## 参考答案。` },
  ], { maxTokens: 8000 });
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || topic || '雅思课程';
  return Number(ctx.db.prepare('INSERT INTO lessons (skill, topic, content) VALUES (?, ?, ?)').run(skill, title.slice(0, 200), markdown).lastInsertRowid);
}

// —— 今日训练计划 ——
export async function generateDailyPlan(ctx) {
  const countdown = examCountdown(ctx.profile);
  const data = await chatJson(ctx.llm, [
    { role: 'system', content: '你是学员的雅思一对一老师，负责每天的训练编排。' },
    { role: 'user', content: `${profileText(ctx.profile)}\n${snapshotText(ctx.snapshot)}
学员计划：\n${planSummary(ctx.plan)}
今天是 ${todayKey()}${countdown != null ? `，距离考试 ${countdown} 天` : ''}。请编排今天的训练，总时长约 ${ctx.profile.dailyMinutes} 分钟，优先补最弱项，兼顾词汇复习与口语输出。
可用模块 module：drill（必须给 skill: listening|reading|writing|speaking 与 type，type 取值 ${JSON.stringify(Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, v.map((i) => i.type)])))}）、course（给 skill 与 topic）、vocab、listening（真题精听）、stories（口语素材）、predict、mock。
输出 {"focus":"今日重点（中文一句）","items":[{"module":"drill","skill":"writing","type":"task2","topic":"","title":"中文任务名","minutes":40,"why":"中文：为什么今天练它"}]}，4–6 项。${jsonOnly}` },
  ]);
  const items = (data.items || []).map((item) => ({ ...item, done: false }));
  ctx.db.prepare('INSERT INTO daily_plans (date, items) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET items = excluded.items, created_at = CURRENT_TIMESTAMP')
    .run(todayKey(), JSON.stringify({ focus: data.focus || '', items }));
}

// —— 预测命中 ——
export async function generatePrediction(ctx) {
  const library = libraryContext(ctx.db, '口语题库 机经 预测 Part 2 话题 写作 题目', 4);
  return chatJson(ctx.llm, [
    { role: 'system', content: '你是熟悉雅思题库更替规律的老师，诚实说明预测依据。' },
    { role: 'user', content: `${profileText(ctx.profile)}
学员要做 10–20 分钟的“预测命中”快速练习。请结合以下资料片段（来自学员 NAS，可能为空）和近年高频话题规律，列出最值得准备的口语与写作话题。没有官方预测，必须在 basis 中说明依据与不确定性。
${library.text || '（资料库暂无相关片段）'}
输出 {"basis":"中文依据说明","speaking":[{"part":"part1","topic":"话题","questions":["问题"]},{"part":"part2","topic":"Describe ...","cueCard":{"topic":"Describe ...","points":["..."],"ending":"and explain ..."}},{"part":"part3","topic":"主题","questions":["问题"]}],"writing":[{"type":"task2","title":"题目原文","essayType":"opinion"}]}。
数量：Part 1 话题 3 个、Part 2 话题 2 个、Part 3 话题 1 个、写作 Task 2 题目 2 个。${jsonOnly}` },
  ], { maxTokens: 8000 }).then((data) => ({ ...data, sources: library.sources }));
}

// —— 口语素材 ——
export async function analyzeStory(ctx, story) {
  return chatJson(ctx.llm, [
    { role: 'system', content: '你是雅思口语老师，擅长把学员的真实经历改造成可复用的答题素材。' },
    { role: 'user', content: `${profileText(ctx.profile)}
学员的个人经历素材：
标题：${story.title}
${story.story}

请匹配这段经历最能用上的雅思口语题目（Part 2 为主，兼顾 Part 1/3，共 5–8 个），补充地道的英式表达，并给最匹配的 Part 2 写一份答题提纲。坚持“说人话”，不要模板化。
输出 {"topics":[{"part":"part2","topic":"Describe ...","howToUse":"中文：怎么把这段经历用过去"}],"expressions":[{"en":"","zh":"","note":"用法"}],"outline":"英文要点提纲"}。${jsonOnly}` },
  ]);
}

// —— 词汇 ——
export async function explainWord(ctx, word) {
  return chatJson(ctx.llm, [
    { role: 'system', content: '你是雅思词汇老师，释义准确，例句地道（英式）。' },
    { role: 'user', content: `解释单词或词组「${word}」，侧重雅思写作与口语中的用法。输出 {"word":"规范形式","meaning":"中文释义（含词性）","example":"英式例句","note":"常见搭配 / 同义替换 / 易错点"}。${jsonOnly}` },
  ]);
}

export async function topicWords(ctx, topic) {
  return chatJson(ctx.llm, [
    { role: 'system', content: '你是雅思词汇老师。' },
    { role: 'user', content: `${profileText(ctx.profile)}\n为雅思话题「${topic}」整理 15 个对 ${ctx.profile.targetBand} 分最有用的词或词伙（避免过于基础的词）。输出 {"words":[{"word":"","meaning":"中文","example":"英式例句","note":"搭配"}]}。${jsonOnly}` },
  ]);
}

export function buildContext(db, llm, profile, plan) {
  return { db, llm, profile, plan, snapshot: learnerSnapshot(db) };
}
