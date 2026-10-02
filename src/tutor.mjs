// 老师的上下文：学员档案 + 工作台雅思计划 + 最近练习表现 + 资料库检索结果。
import { parseJson } from './db.mjs';
import { planSummary } from './plan.mjs';
import { searchLibrary } from './library.mjs';
import { daysBetween, todayKey } from './util.mjs';

export const skillNames = { listening: '听力', reading: '阅读', writing: '写作', speaking: '口语' };

export const defaultProfile = {
  name: '',
  targetBand: '7.0',
  examType: 'Academic',
  examDate: '',
  accent: '清晰自然的英语发音',
  dailyMinutes: '60',
  currentLevel: '',
  notes: '',
  model: '',
};

export function readProfile(db, plan) {
  const rows = db.prepare('SELECT key, value FROM profile').all();
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const fromPlan = plan ? { targetBand: String(plan.goal || ''), examDate: /^\d{4}-\d{2}-\d{2}$/.test(plan.examDate || '') ? plan.examDate : '' } : {};
  const profile = { ...defaultProfile };
  for (const [key, value] of Object.entries(fromPlan)) if (value) profile[key] = value;
  return { ...profile, ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== '')) };
}

export function saveProfile(db, patch) {
  const upsert = db.prepare('INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const key of Object.keys(defaultProfile)) {
    if (key in patch) upsert.run(key, String(patch[key] ?? '').slice(0, 2000));
  }
}

export function learnerSnapshot(db) {
  const recent = db.prepare(`SELECT id, skill, type, title, band, result, graded_at FROM tasks
    WHERE status = 'graded' ORDER BY graded_at DESC LIMIT 30`).all();
  const bySkill = {};
  for (const task of recent) {
    if (task.band == null) continue;
    (bySkill[task.skill] ||= []).push(task.band);
  }
  const averages = Object.fromEntries(Object.entries(bySkill).map(([skill, bands]) => {
    const last = bands.slice(0, 5);
    return [skill, Math.round((last.reduce((a, b) => a + b, 0) / last.length) * 10) / 10];
  }));
  const focuses = recent.map((task) => parseJson(task.result, {})?.nextFocus).filter(Boolean).slice(0, 5);
  const dueVocab = db.prepare("SELECT COUNT(*) AS n FROM vocab WHERE due_at <= ?").get(todayKey()).n;
  return { recent: recent.slice(0, 10), averages, focuses, dueVocab };
}

export function snapshotText(snapshot) {
  const lines = [];
  const averages = Object.entries(snapshot.averages);
  lines.push(averages.length ? `近期分项估分：${averages.map(([skill, band]) => `${skillNames[skill] || skill} ${band}`).join('，')}` : '近期分项估分：暂无（还没有批改记录）');
  if (snapshot.recent.length) {
    lines.push('最近练习：');
    for (const task of snapshot.recent) lines.push(`- ${task.graded_at?.slice(0, 10)} ${skillNames[task.skill] || task.skill}·${task.type}「${task.title || ''}」${task.band != null ? `估分 ${task.band}` : ''}`);
  }
  if (snapshot.focuses.length) lines.push(`批改指出的待改进点：${snapshot.focuses.join('；')}`);
  lines.push(`今日到期词汇：${snapshot.dueVocab} 个`);
  return lines.join('\n');
}

export function examCountdown(profile) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.examDate || '')) return null;
  return daysBetween(todayKey(), profile.examDate);
}

export function profileText(profile) {
  const countdown = examCountdown(profile);
  return [
    `学员档案：${profile.name ? `${profile.name}，` : ''}${profile.examType} 类，目标总分 ${profile.targetBand}，口音目标 ${profile.accent}，每天可投入约 ${profile.dailyMinutes} 分钟。`,
    profile.examDate ? `考试日期 ${profile.examDate}${countdown != null ? `（还有 ${countdown} 天）` : ''}。` : '考试日期未定。',
    profile.currentLevel && `当前水平自述：${profile.currentLevel}`,
    profile.notes && `学员备注：${profile.notes}`,
  ].filter(Boolean).join('\n');
}

export function libraryContext(db, query, limit = 4) {
  const hits = searchLibrary(db, query, limit).filter((hit) => hit.chunk);
  if (!hits.length) return { text: '', sources: [] };
  return {
    text: hits.map((hit, index) => `[资料${index + 1}]《${hit.title}》（${hit.path}）\n${hit.chunk.slice(0, 900)}`).join('\n\n'),
    sources: hits.map((hit) => ({ docId: hit.docId, title: hit.title, path: hit.path })),
  };
}

export function tutorSystemPrompt({ profile, plan, snapshot, library = '', viewContext = '' }) {
  return [
    '你是学员的专属雅思一对一老师，熟悉剑桥真题、官方评分标准和中国考生的常见问题。',
    '原则：用中文讲解、用英文示范；英文统一英式拼写与用词；回答具体、可执行，优先给下一步行动；',
    '不编造真题出处或考试政策——涉及最新政策、考位、院校要求时提醒以官方为准；引用学员资料时注明《文件名》；',
    '尊重学员的学习计划：不背模板、“说人话”、口语按现代伦敦标准英音目标纠正。',
    '',
    profileText(profile),
    '',
    '工作台雅思计划（学员自己制定，应作为训练依据）：',
    planSummary(plan),
    '',
    snapshotText(snapshot),
    library && `\n学员 NAS 资料库中与本问题相关的片段：\n${library}`,
    viewContext && `\n学员当前正在看的内容：\n${viewContext}`,
  ].filter((line) => line !== false && line != null).join('\n');
}
