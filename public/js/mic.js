// 麦克风输入：录音 → NAS /api/stt → 文字追加进输入框。
// 浏览器只在安全上下文（HTTPS，即经 Lucky 域名访问，或 localhost）开放麦克风。
import { toast, cleanup, requireLogin, session, ensureFeature, warnMicrophone } from './core.js';

export const micSupported = () => Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

// 查询权限不申请录音；支持录音不等于已经获得用户授权。
export function microphoneStatus({ secure = window.isSecureContext, supported = micSupported(), permission } = {}) {
  if (!secure) return { label: '需要 HTTPS', style: 'warning' };
  if (!supported) return { label: '浏览器不支持', style: 'warning' };
  if (permission === 'granted') return { label: '已授权', style: 'ready' };
  if (permission === 'denied') return { label: '已拒绝', style: 'warning' };
  if (permission === 'prompt') return { label: '待授权', style: 'neutral' };
  return { label: '权限未知', style: 'neutral' };
}

const preferredType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
const MAX_SECONDS = 15 * 60;
let current = null;

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// 返回一个按钮：按一下开始录音，再按一下结束并转写。lang: 'en'（口语作答）| 'auto'（对话，中英混说）。
// keep 为真时服务端保存录音，onResult 收到 { text, duration, recordingId }。scoped 为真时切换页面即丢弃未完成的录音。
export function micButton(field, { lang = 'en', keep = false, prompt = '', onResult, scoped = true } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mic-btn';
  button.textContent = '🎙️';
  if (!micSupported()) {
    button.disabled = true;
    button.title = '麦克风需要经 HTTPS（Lucky 域名）访问';
    return button;
  }
  let state = null;
  const updateAvailability = () => {
    if (state || button.classList.contains('working')) return;
    button.disabled = !session.authenticated || !session.sttConfigured;
    button.title = !session.authenticated ? '登录并验证语音转写后可用' : !session.sttConfigured ? '语音转写测试通过并保存后可用' : '点一下开始录音，再点一下结束并转成文字';
    button.setAttribute('aria-label', button.title);
  };
  updateAvailability();
  window.addEventListener('ieltsbuddy:access', updateAvailability);
  if (scoped) cleanup.add(() => window.removeEventListener('ieltsbuddy:access', updateAvailability));

  const reset = () => {
    clearInterval(state?.timer);
    state?.stream.getTracks().forEach((track) => track.stop());
    state = null;
    if (current === stop) current = null;
    button.classList.remove('recording', 'working');
    button.disabled = false;
    button.textContent = '🎙️';
    updateAvailability();
  };

  async function upload(blob) {
    button.classList.add('working');
    button.disabled = true;
    button.textContent = '转写中…';
    try {
      const query = new URLSearchParams({ lang, keep: keep ? '1' : '0', prompt });
      const response = await fetch(`/api/stt?${query}`, { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) requireLogin();
      if (!response.ok) throw new Error(data.error || `转写失败（${response.status}）`);
      if (!data.text) { toast('没有听清，请再录一次', 'error'); return; }
      const before = field.value;
      field.value = before && !/\s$/.test(before) ? `${before} ${data.text}` : `${before}${data.text}`;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      onResult?.(data);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.classList.remove('working');
      button.disabled = false;
      button.textContent = '🎙️';
      updateAvailability();
    }
  }

  function stop(discard = false) {
    if (!state) return;
    state.discard = discard;
    if (state.recorder.state !== 'inactive') state.recorder.stop();
    else reset();
  }

  async function start() {
    if (!ensureFeature('stt')) return;
    current?.();
    try {
      let permission;
      try { permission = await navigator.permissions?.query({ name: 'microphone' }); } catch { /* Safari 等浏览器由 getUserMedia 返回权限结果 */ }
      if (permission?.state === 'denied') { warnMicrophone(); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = preferredType();
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      state = { stream, recorder, started: Date.now(), discard: false };
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => {
        const discard = state?.discard;
        const blob = new Blob(chunks, { type: (recorder.mimeType || type || 'audio/webm').split(';')[0] });
        reset();
        if (!discard) upload(blob);
      });
      recorder.start();
      current = stop;
      button.classList.add('recording');
      const tick = () => {
        const seconds = Math.round((Date.now() - state.started) / 1000);
        button.textContent = `■ ${clock(seconds)}`;
        if (seconds >= MAX_SECONDS) stop();
      };
      tick();
      state.timer = setInterval(tick, 500);
    } catch (error) {
      reset();
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) warnMicrophone();
      else toast(`无法打开麦克风：${error.message}`, 'error');
    }
  }

  button.addEventListener('click', () => (state ? stop() : start()));
  if (scoped) cleanup.add(() => stop(true));
  return button;
}
