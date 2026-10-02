import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const zeroSha = /^0+$/;
const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const requiredHeadings = [
  '## 用户目标',
  '## 沟通结论',
  '## 实施记录',
  '## 验证结果',
  '## 教程提炼',
  '## 隐私检查'
];

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', input }).trim();
}

function changesBetween(base, head) {
  if (zeroSha.test(base)) {
    return git(['diff', '--name-status', emptyTreeSha, head]);
  }
  return git(['diff', '--name-status', base, head]);
}

function pushedRefs() {
  const rangeIndex = process.argv.indexOf('--range');
  if (rangeIndex >= 0) {
    const base = process.argv[rangeIndex + 1];
    const head = process.argv[rangeIndex + 2];
    if (!base || !head) throw new Error('用法：--range <base> <head>');
    return [{ localSha: head, remoteSha: base }];
  }

  return readFileSync(0, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [, localSha, , remoteSha] = line.trim().split(/\s+/);
      return { localSha, remoteSha };
    })
    .filter(({ localSha }) => localSha && !zeroSha.test(localSha));
}

function fail(message) {
  console.error(`\n[communication-log] ${message}`);
  console.error('[communication-log] 请先新增本次推送纪要并更新 INDEX.md。\n');
  process.exit(1);
}

const refs = pushedRefs();
for (const { localSha, remoteSha } of refs) {
  const changes = changesBetween(remoteSha, localSha).split(/\r?\n/).filter(Boolean);
  const indexChanged = changes.some((line) => /\tdocs\/communication-log\/INDEX\.md$/.test(line));
  const addedEntries = changes
    .filter((line) => /^A\s+docs\/communication-log\/entries\/.+\.md$/.test(line))
    .map((line) => line.replace(/^A\s+/, ''));

  if (!indexChanged) fail('本次推送没有更新 docs/communication-log/INDEX.md。');
  if (!addedEntries.length) fail('本次推送没有新增 docs/communication-log/entries/ 下的纪要。');

  for (const entry of addedEntries) {
    const content = git(['show', `${localSha}:${entry}`]);
    const missing = requiredHeadings.filter((heading) => !content.includes(heading));
    if (missing.length) fail(`${entry} 缺少章节：${missing.join('、')}`);
    if (/\b(?:TODO|TBD)\b|待补|稍后补充/i.test(content)) fail(`${entry} 仍含占位内容。`);
  }

  console.log(`[communication-log] 检查通过：${addedEntries.join(', ')}`);
}
