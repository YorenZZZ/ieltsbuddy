// 读取工作台 growth-plans.mjs 的 ieltsPlan（只读挂载），按文件修改时间热更新。
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

let cache = { mtimeMs: 0, plan: null };

export async function loadIeltsPlan(planPath) {
  try {
    const { mtimeMs } = statSync(planPath);
    if (mtimeMs !== cache.mtimeMs) {
      const mod = await import(`${pathToFileURL(planPath).href}?v=${mtimeMs}`);
      cache = { mtimeMs, plan: mod.ieltsPlan || null };
    }
    return cache.plan;
  } catch {
    return null;
  }
}

const stepText = (step) => (typeof step === 'string' ? step : step?.text || '');

export function planSummary(plan) {
  if (!plan) return '（未读取到工作台雅思计划）';
  const lines = [
    `目标总分 ${plan.goal}；每日投入 ${plan.dailyCommitment}；考试日期 ${plan.examDate}；当前阶段：${plan.stage}。`,
    plan.targetNote && `备注：${plan.targetNote}`,
    plan.warnings?.length && `注意事项：${plan.warnings.join('；')}`,
  ];
  for (const module of plan.modules || []) {
    lines.push(`【${module.name}】目标 ${module.target || '-'}；时长 ${module.duration || '-'}；题型：${(module.types || []).join('、')}`);
    for (const step of module.strategies || []) lines.push(`  - ${stepText(step)}`);
    if (module.bloggers?.length) lines.push(`  参考博主：${module.bloggers.map((b) => b.name).join('、')}`);
  }
  if (plan.tools?.length) lines.push(`工具：${plan.tools.map((t) => t.name).join('、')}`);
  if (plan.studyFlow?.length) lines.push(`学习流程：${plan.studyFlow.join(' → ')}`);
  return lines.filter(Boolean).join('\n');
}
