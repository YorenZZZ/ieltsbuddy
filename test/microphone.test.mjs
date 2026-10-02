import test from 'node:test';
import assert from 'node:assert/strict';
import { microphoneStatus } from '../public/js/mic.js';
test('支持录音不代表已授权，未知权限不误报可用，拒绝与不安全环境明确显示', () => {
  const check = (permission) => microphoneStatus({ secure: true, supported: true, permission });
  assert.deepEqual(check('prompt'), { label: '待授权', style: 'neutral' });
  assert.deepEqual(check(undefined), { label: '权限未知', style: 'neutral' });
  assert.deepEqual(check('denied'), { label: '已拒绝', style: 'warning' });
  assert.deepEqual(check('granted'), { label: '已授权', style: 'ready' });
  assert.equal(microphoneStatus({ secure: false, supported: false, permission: 'granted' }).label, '需要 HTTPS');
});

import { micButton } from '../public/js/mic.js';
import { session } from '../public/js/core.js';
test('话筒：未验证禁用；点击才请求权限；浏览器已拒绝时警告并不再次申请', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = Object.fromEntries(['window','navigator','document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  let permission = 'prompt'; let requested = 0;
  const warning = { hidden: true, classList: { remove() {}, add() {} } };
  const makeButton = () => {
    const classes = new Set();
    return { disabled: false, listeners: {}, classList: { contains: (name) => classes.has(name), add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)) }, setAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  };
  const browser = { isSecureContext: true, MediaRecorder: {}, addEventListener() {}, removeEventListener() {} };
  try {
    Object.defineProperty(globalThis,'window',{ configurable:true, value: browser });
    Object.defineProperty(globalThis,'navigator',{ configurable:true, value: { permissions: { query: async () => ({ state: permission }) }, mediaDevices: { getUserMedia: async () => { requested++; throw Object.assign(new Error('Permission denied'),{ name:'NotAllowedError' }); } } } });
    Object.defineProperty(globalThis,'document',{ configurable:true, value: { createElement: makeButton, getElementById: () => warning } });
    Object.assign(session,{ authenticated: true, sttConfigured:false });
    assert.equal(micButton({value:''},{scoped:false}).disabled, true); assert.equal(requested,0);
    session.sttConfigured = true;
    const mic = micButton({value:''},{scoped:false}); assert.equal(mic.disabled,false); assert.equal(requested,0);
    await mic.listeners.click(); assert.equal(requested,1); assert.equal(warning.hidden,false);
    t.mock.timers.tick(3000); t.mock.timers.tick(220); assert.equal(warning.hidden,true);
    permission='denied'; await mic.listeners.click(); assert.equal(requested,1); assert.equal(warning.hidden,false);
    t.mock.timers.tick(3000); t.mock.timers.tick(220);
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; }
    Object.assign(session,{ authenticated:false, sttConfigured:false });
  }
});
