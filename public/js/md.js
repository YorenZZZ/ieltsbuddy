// 轻量 Markdown 渲染：先整体转义再还原结构，链接只放行 http(s)。
import { esc } from './core.js';

const inline = (text) => esc(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

export function markdown(source) {
  const lines = String(source || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`); i += 1; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const head = cells(line);
      const body = [];
      for (i += 2; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i += 1) body.push(cells(lines[i]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i += 1) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i += 1) quote.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s|\|)/.test(lines[i]); i += 1) para.push(lines[i]);
    if (!para.length) { para.push(line); i += 1; }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}
