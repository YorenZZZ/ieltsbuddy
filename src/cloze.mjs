// 精听挖空：每句挑最有信息量的词（数字、长实词）挖空，确定性，便于复现与核对。
const stop = new Set('the a an and or but of to in on at for with from by as is are was were be been being have has had do does did this that these those there their they them we you your our his her its it i he she me my not no so if then than very just also about into over after before because which who whom what when where while will would can could should shall may might must'.split(' '));

export function clozeSegment(text, maxBlanks = 2) {
  const tokens = String(text).split(/(\s+)/);
  const candidates = [];
  tokens.forEach((token, index) => {
    const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!core || stop.has(core.toLowerCase())) return;
    const score = /\d/.test(core) ? 100 : core.length >= 4 ? core.length : 0;
    if (score) candidates.push({ index, core, score });
  });
  const chosen = candidates.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, maxBlanks).sort((a, b) => a.index - b.index);
  const parts = [];
  const answers = [];
  let buffer = '';
  tokens.forEach((token, index) => {
    const hit = chosen.find((c) => c.index === index);
    if (!hit) { buffer += token; return; }
    const at = token.indexOf(hit.core);
    buffer += token.slice(0, at);
    if (buffer) parts.push({ text: buffer });
    parts.push({ blank: answers.length });
    answers.push(hit.core);
    buffer = token.slice(at + hit.core.length);
  });
  if (buffer) parts.push({ text: buffer });
  return { parts, answers };
}

export function splitSentences(text) {
  return String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim()).filter((s) => s.length > 1);
}
