import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { effectiveSettings, publicSettings, saveSettings, storedSettings } from '../src/settings.mjs';
import { createAdmin, readAdmin } from '../src/admin.mjs';
import { validPassword } from '../src/auth.mjs';
const env = { HOLYSHEEP_API_KEY: 'unit-test-main-secret', HOLYSHEEP_MODEL: 'model-a', GROQ_API_KEY: 'unit-test-speech-secret' };

test('设置回退、热更新、空密钥不覆盖、空模型恢复环境默认', () => {
  const db = openDatabase(':memory:');
  assert.equal(effectiveSettings(db, env).llm.model, 'model-a');
  saveSettings(db, { llmModel: 'model-b', llmApiKey: 'saved-test-secret' });
  assert.equal(effectiveSettings(db, env).llm.model, 'model-b');
  saveSettings(db, { llmApiKey: '', llmModel: '' });
  assert.equal(effectiveSettings(db, env).llm.apiKey, 'saved-test-secret');
  assert.equal(effectiveSettings(db, env).llm.model, 'model-a');
  db.close();
});

test('设置校验失败不会保存部分字段，拒绝不合法 URL、类型与目录', () => {
  const db = openDatabase(':memory:');
  saveSettings(db, { llmModel: 'original' });
  for (const patch of [{ llmBaseUrl: 'https://api.example.com/v1', llmModel: 'new', libraryDir: '/missing-unit-test-dir' }, { llmBaseUrl: 'https://user:secret@example.com' }, { llmBaseUrl: 'https://example.com/?key=secret' }, { llmBaseUrl: 'file:///tmp' }, { llmModel: {} }, null, []]) {
    assert.throws(() => saveSettings(db, patch), { statusCode: 400 });
    assert.deepEqual(storedSettings(db), { llmModel: 'original' });
  }
  db.close();
});

test('目录存在才能保存；公开设置不返回完整密钥和管理员秘密', () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'ib-settings-'));
  try {
    saveSettings(db, { libraryDir: dir });
    createAdmin(db, { username: 'admin', password: 'test-password-123', passwordConfirm: 'test-password-123' }, {});
    const value = publicSettings(db, env);
    assert.equal(value.libraryDir, dir);
    assert.equal(value.llm.hasKey, true);
    assert.equal(value.stt.hasKey, true);
    const json = JSON.stringify(value);
    assert.ok(!json.includes(env.HOLYSHEEP_API_KEY));
    assert.ok(!json.includes(env.GROQ_API_KEY));
    assert.ok(!json.includes('passwordHash'));
    assert.deepEqual(Object.keys(value).sort(), ['libraryDir', 'llm', 'stt']);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('首次管理员持久化，只能创建一次，兼容已有环境登录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ib-admin-'));
  const path = join(dir, 'db.sqlite');
  let db = openDatabase(path);
  try {
    assert.equal(readAdmin(db, {}).enabled, false);
    assert.throws(() => createAdmin(db, { username: 'admin', password: 'short', passwordConfirm: 'short' }, {}), { statusCode: 400 });
    const auth = createAdmin(db, { username: 'admin', password: 'test-password-123', passwordConfirm: 'test-password-123' }, {});
    assert.equal(validPassword(auth, 'test-password-123'), true);
    assert.equal(validPassword(auth, 'wrong-password'), false);
    assert.throws(() => createAdmin(db, {}, {}), { statusCode: 409 });
    db.close(); db = openDatabase(path);
    assert.deepEqual(readAdmin(db, {}), auth);
    const existingEnv = { IELTSBUDDY_USERNAME: 'existing', IELTSBUDDY_PASSWORD_HASH: auth.passwordHash, IELTSBUDDY_SESSION_SECRET: auth.secret };
    assert.equal(readAdmin(db, existingEnv).username, 'existing');
    assert.throws(() => createAdmin(db, {}, existingEnv), { statusCode: 409 });
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});
