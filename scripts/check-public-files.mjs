// 对即将公开的 Git 文件进行确定性隐私检查；开发数据和凭据必须留在仓库外。
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = [];
for (const file of files) {
  if (/^(?:data|library|node_modules|secrets)\//.test(file) || /(?:^|\/)\.env(?:\..*)?$/.test(file) && file !== '.env.example' || /(?:^|\/)HANDOFF[^/]*\.md$|compose\.nas|\.(?:sqlite\w*|db|log)$/.test(file)) { bad.push(file + ': private file'); continue; }
  if (lstatSync(file).isSymbolicLink()) { bad.push(file + ': symlink'); continue; }
  const content = readFileSync(file, 'utf8');
  if (/\/Users\/|\/vol\d\/\d+\/|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|gho_|github_pat_|gsk_|sk-)[A-Za-z0-9_]{20,}/.test(content)) bad.push(file + ': private path or secret pattern');
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`Public-file check passed: ${files.length} files; no private data paths or secret patterns.`);
