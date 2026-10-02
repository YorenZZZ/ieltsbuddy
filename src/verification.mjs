import { createHash, randomUUID } from 'node:crypto';
import { candidateSettings, effectiveSettings } from './settings.mjs';
import { parseJson } from './db.mjs';
import { httpError } from './util.mjs';

const signature = (config) => createHash('sha256').update(JSON.stringify([config.baseUrl, config.apiKey, config.model])).digest('hex');
const read = (db, key) => parseJson(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value);
const write = (db, key, value) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const latestKey = (provider) => `verification:${provider}:latest`;
const activeKey = (provider) => `verification:${provider}:active`;
const filled = (config) => Boolean(config.baseUrl && config.apiKey && config.model);

export function verificationState(db, provider, config = effectiveSettings(db)[provider]) {
  const active = read(db, activeKey(provider));
  const latest = read(db, latestKey(provider));
  const hash = signature(config);
  const verified = filled(config) && active?.signature === hash && active.status === 'passed'
    && !(latest?.signature === hash && latest.status === 'failed');
  return { filled: filled(config), verified: Boolean(verified), verifiedAt: verified ? active.verifiedAt : null };
}
export function verifiedConfig(db, provider) {
  const config = effectiveSettings(db)[provider];
  return verificationState(db, provider, config).verified ? config : { ...config, apiKey: '' };
}
export function beginVerification(db, provider, patch) {
  const config = candidateSettings(db, patch)[provider];
  if (!filled(config)) throw Object.assign(httpError(400, '请完整填写接口地址、密钥与模型后再测试'), { code: provider === 'llm' ? 'AI_NOT_CONFIGURED' : 'STT_NOT_CONFIGURED' });
  const attempt = { id: randomUUID(), signature: signature(config), status: 'testing', testedAt: new Date().toISOString(), verifiedAt: null };
  write(db, latestKey(provider), attempt);
  return { config, attempt };
}
export function finishVerification(db, provider, attempt, passed) {
  if (read(db, latestKey(provider))?.id !== attempt.id) return false; // 较早测试即使较晚结束，也不能覆盖较新测试。
  const record = { ...attempt, status: passed ? 'passed' : 'failed', finishedAt: new Date().toISOString(), verifiedAt: passed ? new Date().toISOString() : null };
  write(db, latestKey(provider), record);
  return record;
}
export function saveVerifiedSettings(db, patch) {
  const candidate = candidateSettings(db, patch);
  const records = [];
  const current = effectiveSettings(db);
  for (const provider of ['llm', 'stt']) {
    const config = candidate[provider];
    const submitted = Object.keys(patch).some((key) => key.startsWith(provider));
    if (submitted && !filled(config) && signature(config) !== signature(current[provider])) throw httpError(400, `请完整填写${provider === 'llm' ? '主AI' : '语音转写AI'}配置，测试通过后再保存`);
    if (!submitted || !filled(config)) continue; // 未填写的可选语音服务不阻塞其他设置。
    const latest = read(db, latestKey(provider));
    // 保存其他设置时，未改动的已验证配置仍有效；未保存的其他候选测试不会替换它。
    const record = latest?.signature === signature(config) ? latest : signature(config) === signature(current[provider]) && verificationState(db, provider).verified ? read(db, activeKey(provider)) : latest;
    if (record?.status !== 'passed' || record.signature !== signature(config)) {
      throw Object.assign(httpError(409, `最新版${provider === 'llm' ? '主AI' : '语音转写AI'}配置没有经过测试，请重新测试通过后保存`), { code: 'AI_CONFIG_UNVERIFIED' });
    }
    records.push([provider, record]);
  }
  // saveSettings 自带校验及事务；下面的同步写入与它处于同一次数据库事务。
  db.exec('SAVEPOINT verified_settings');
  try {
    // 此处复用已验证字段的存储，避免嵌套 BEGIN。
    const values = Object.fromEntries(Object.entries(patch).filter(([key]) => ['llmBaseUrl','llmApiKey','llmModel','sttBaseUrl','sttApiKey','sttModel','libraryDir'].includes(key)));
    for (const [key, value] of Object.entries(values)) {
      if (key.endsWith('ApiKey') && !value.trim()) continue;
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value.trim());
    }
    for (const [provider, record] of records) write(db, activeKey(provider), record);
    db.exec('RELEASE verified_settings');
  } catch (error) { db.exec('ROLLBACK TO verified_settings'); db.exec('RELEASE verified_settings'); throw error; }
  return candidate;
}
