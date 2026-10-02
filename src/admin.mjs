import { randomBytes, scryptSync } from 'node:crypto';
import { authConfig } from './auth.mjs';
import { httpError } from './util.mjs';

// 既有 .env 登录继续有效；新安装的管理员在服务端 SQLite 持久化。
export function readAdmin(db, env = process.env) {
  const existing = authConfig(env);
  if (existing.enabled) return existing;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin'").get();
  if (!row) return existing;
  const saved = JSON.parse(row.value);
  return authConfig({ IELTSBUDDY_USERNAME: saved.username, IELTSBUDDY_PASSWORD_HASH: saved.passwordHash, IELTSBUDDY_SESSION_SECRET: saved.secret });
}

export function createAdmin(db, input, env = process.env) {
  if (readAdmin(db, env).enabled) throw httpError(409, '管理员已设置，请登录');
  const { username, password, passwordConfirm } = input || {};
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(username.trim())) throw httpError(400, '用户名需为 1–64 位文字、数字、下划线、点或短横线');
  if (typeof password !== 'string' || password.length < 10 || Buffer.byteLength(password) > 256) throw httpError(400, '密码至少 10 位，最多 256 字节');
  if (password !== passwordConfirm) throw httpError(400, '两次密码不一致');
  const salt = randomBytes(16).toString('hex');
  const saved = { username: username.trim(), passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`, secret: randomBytes(32).toString('hex') };
  // 唯一键拒绝同时到来的第二次初始化，绝不覆盖已有账号。
  const result = db.prepare("INSERT INTO settings (key, value) VALUES ('admin', ?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(saved));
  if (!result.changes) throw httpError(409, '管理员已设置，请登录');
  return readAdmin(db, env);
}
