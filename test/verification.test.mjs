import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.mjs';
import { beginVerification, finishVerification, saveVerifiedSettings, verificationState, verifiedConfig } from '../src/verification.mjs';

const A = { llmBaseUrl: 'https://ai.example.com/v1', llmApiKey: 'verification-secret-A', llmModel: 'version-A' };
const B = { ...A, llmModel: 'version-B' };
test('测试绑定完整配置：A 通过不能保存 B，最新失败覆盖旧通过，时间戳与密钥保留规则一致', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => saveVerifiedSettings(db, A), { code: 'AI_CONFIG_UNVERIFIED' });
    const a = beginVerification(db, 'llm', A); const passed = finishVerification(db, 'llm', a.attempt, true);
    assert.ok(Date.parse(passed.verifiedAt));
    assert.equal(verifiedConfig(db, 'llm').apiKey, '');
    assert.throws(() => saveVerifiedSettings(db, B), { code: 'AI_CONFIG_UNVERIFIED' });
    saveVerifiedSettings(db, A);
    assert.equal(verificationState(db, 'llm').verifiedAt, passed.verifiedAt);
    assert.equal(verifiedConfig(db, 'llm').model, 'version-A');
    const keyChanged = { ...A, llmApiKey: 'verification-secret-B' };
    assert.throws(() => saveVerifiedSettings(db, keyChanged), { code: 'AI_CONFIG_UNVERIFIED' });
    const blankKey = { ...A, llmApiKey: '' };
    saveVerifiedSettings(db, blankKey); assert.equal(verifiedConfig(db, 'llm').apiKey, A.llmApiKey);
    const retest = beginVerification(db, 'llm', blankKey); const newest = finishVerification(db, 'llm', retest.attempt, true); saveVerifiedSettings(db, blankKey);
    const active = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'verification:llm:active'").get().value);
    assert.equal(active.id, retest.attempt.id); assert.equal(active.verifiedAt, newest.verifiedAt);
    const failed = beginVerification(db, 'llm', blankKey); finishVerification(db, 'llm', failed.attempt, false);
    assert.equal(verificationState(db, 'llm').verified, false);
    assert.throws(() => saveVerifiedSettings(db, blankKey), { code: 'AI_CONFIG_UNVERIFIED' });
    const b = beginVerification(db, 'llm', B); finishVerification(db, 'llm', b.attempt, true); saveVerifiedSettings(db, B);
    assert.equal(verifiedConfig(db, 'llm').model, 'version-B');
    const records = db.prepare("SELECT value FROM settings WHERE key LIKE 'verification:%'").all();
    assert.ok(records.every(({ value }) => !value.includes('verification-secret')));
    assert.throws(() => saveVerifiedSettings(db, { ...B, libraryDir: '/does-not-exist-test' }), { statusCode: 400 });
    assert.equal(verifiedConfig(db, 'llm').model, 'version-B');
  } finally { db.close(); }
});
test('在途测试乱序返回时，旧测试无法覆盖最后发起的版本，也无法凭旧结果保存', () => {
  const db = openDatabase(':memory:');
  try {
    const a = beginVerification(db, 'llm', A);
    const b = beginVerification(db, 'llm', B);
    assert.equal(finishVerification(db, 'llm', a.attempt, true), false);
    assert.throws(() => saveVerifiedSettings(db, A), { code: 'AI_CONFIG_UNVERIFIED' });
    finishVerification(db, 'llm', b.attempt, true);
    assert.equal(finishVerification(db, 'llm', a.attempt, false), false);
    saveVerifiedSettings(db, B); assert.equal(verifiedConfig(db, 'llm').model, 'version-B');
  } finally { db.close(); }
});
test('测试过尚未保存的候选 B，不影响已保存 A 的沿用；A 的最新失败仍会阻止沿用', () => {
  const db = openDatabase(':memory:');
  try {
    const a = beginVerification(db, 'llm', A); finishVerification(db, 'llm', a.attempt, true); saveVerifiedSettings(db, A);
    const b = beginVerification(db, 'llm', B); finishVerification(db, 'llm', b.attempt, true);
    saveVerifiedSettings(db, { ...A, llmApiKey: '' }); assert.equal(verifiedConfig(db,'llm').model,'version-A');
    const fail = beginVerification(db,'llm',A); finishVerification(db,'llm',fail.attempt,false);
    assert.throws(() => saveVerifiedSettings(db,A), {code:'AI_CONFIG_UNVERIFIED'});
  } finally { db.close(); }
});
