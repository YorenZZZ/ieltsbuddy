// HolySheep 走 OpenAI 兼容接口；密钥只在服务端读取。模型可在设置页覆盖（存 profile.model）。
export function llmConfig(env = process.env) {
  return {
    baseUrl: (env.HOLYSHEEP_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env.HOLYSHEEP_API_KEY || '',
    model: env.HOLYSHEEP_MODEL || '',
  };
}

// HolySheep 没有语音转写，转写（麦克风作答、听力精听）走 Groq 的 OpenAI 兼容 Whisper 接口。
export function sttConfig(env = process.env) {
  return {
    baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    apiKey: env.GROQ_API_KEY || '',
    model: env.GROQ_STT_MODEL || 'whisper-large-v3',
  };
}

export const sttReady = (config) => Boolean(config.baseUrl && config.apiKey && config.model);

export const llmReady = (config) => Boolean(config.baseUrl && config.apiKey && config.model);

function assertReady(config) {
  if (!llmReady(config)) {
    throw Object.assign(new Error('主 AI 未配置：请到「设置」填写接口地址、密钥与模型'), { statusCode: 503, code: 'AI_NOT_CONFIGURED' });
  }
}

async function post(config, path, body, timeoutMs) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`主 AI ${response.status}：${safeProviderError(data, config.apiKey, '请求失败')}`), { statusCode: 502 });
  }
  return response;
}

export async function chatCompletion(config, messages, { temperature = 0.7, maxTokens = 8000, timeoutMs = 300_000 } = {}) {
  assertReady(config);
  const response = await post(config, '/chat/completions', { model: config.model, messages, temperature, max_tokens: maxTokens }, timeoutMs);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// 流式对话：逐段回调 delta，返回完整文本。
export async function streamCompletion(config, messages, onDelta, { temperature = 0.7, maxTokens = 8000 } = {}) {
  assertReady(config);
  const response = await post(config, '/chat/completions', { model: config.model, messages, temperature, max_tokens: maxTokens, stream: true }, 300_000);
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) { full += delta; onDelta(delta); }
    }
  }
  return full;
}

// 从模型输出中取出第一个完整 JSON 对象（容忍 ```json 包裹与前后说明文字）。
export function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) throw new Error('模型未返回 JSON');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
  }
  throw new Error('模型返回的 JSON 不完整');
}

export async function chatJson(config, messages, options = {}) {
  const text = await chatCompletion(config, messages, { temperature: 0.4, ...options });
  try {
    return extractJson(text);
  } catch {
    const retry = await chatCompletion(config, [...messages, { role: 'assistant', content: text }, { role: 'user', content: '请只输出符合要求的完整 JSON 对象，不要任何其他文字。' }], { temperature: 0.2, ...options });
    return extractJson(retry);
  }
}

export async function listModels(config) {
  if (!config.apiKey) return [];
  const response = await fetch(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Object.assign(new Error(`主 AI ${response.status}：无法读取模型列表`), { statusCode: 502 });
  const data = await response.json();
  return (data.data || []).map((model) => model.id).filter(Boolean).sort();
}

// 语音转写（/audio/transcriptions，verbose_json 带分段时间戳）。language 留空时由 Whisper 自动识别（对话可中英混说）。
export async function transcribe(config, audio, { filename = 'audio.mp3', mime = 'audio/mpeg', language = 'en', prompt = '', timeoutMs = 600_000 } = {}) {
  if (!sttReady(config)) throw Object.assign(new Error('语音转写未配置：请到「设置」填写语音转写的接口、密钥与模型'), { statusCode: 503, code: 'STT_NOT_CONFIGURED' });
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), filename);
  form.append('model', config.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt.slice(0, 800));
  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = response.status === 403 ? '（请检查服务商权限与 NAS 出口网络）' : '';
    throw Object.assign(new Error(`语音转写失败（${response.status}）：${safeProviderError(data, config.apiKey, '接口不可用')}${hint}`), { statusCode: 502 });
  }
  if (!data || (typeof data.text !== 'string' && !Array.isArray(data.segments))) throw Object.assign(new Error('语音转写接口未返回有效结果'), { statusCode: 502 });
  const segments = (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })).filter((s) => s.text);
  return { text: String(data.text || segments.map((s) => s.text).join(' ')).trim(), duration: Number(data.duration) || segments.at(-1)?.end || null, segments };
}

function safeProviderError(data, key, fallback) {
  const message = String(data.error?.message || data.message || fallback);
  return (key ? message.replaceAll(key, '[密钥已隐藏]') : message).slice(0, 500);
}
