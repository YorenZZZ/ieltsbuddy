// 写作 Task 1 图表：柱状 / 折线 / 饼图 / 表格，纯 SVG。
import { esc } from './core.js';

const palette = ['#7c5cdb', '#4fa38a', '#e08a3c', '#d1547a', '#3b82c4', '#a3a33a'];

export function chartSvg(chart) {
  if (!chart) return '';
  const categories = chart.categories || [];
  const series = chart.series || [];
  if (chart.type === 'table' || !categories.length) {
    return `<div class="table-wrap"><table><thead><tr><th>${esc(chart.unit || '')}</th>${categories.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${series.map((s) => `<tr><th>${esc(s.name)}</th>${(s.values || []).map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const legend = `<div class="legend">${(chart.type === 'pie' ? categories : series.map((s) => s.name)).map((name, i) => `<span><i style="background:${palette[i % palette.length]}"></i>${esc(name)}</span>`).join('')}</div>`;
  if (chart.type === 'pie') {
    const values = series[0]?.values || [];
    const total = values.reduce((a, b) => a + Number(b || 0), 0) || 1;
    let angle = -Math.PI / 2;
    const slices = values.map((value, i) => {
      const sweep = (Number(value) / total) * Math.PI * 2;
      const [x1, y1] = [150 + 110 * Math.cos(angle), 130 + 110 * Math.sin(angle)];
      angle += sweep;
      const [x2, y2] = [150 + 110 * Math.cos(angle), 130 + 110 * Math.sin(angle)];
      const mid = angle - sweep / 2;
      return `<path d="M150 130 L${x1} ${y1} A110 110 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" fill="${palette[i % palette.length]}"/><text x="${150 + 70 * Math.cos(mid)}" y="${134 + 70 * Math.sin(mid)}" text-anchor="middle" class="pie-label">${esc(value)}</text>`;
    }).join('');
    return `<figure class="chart"><figcaption>${esc(chart.title)}${chart.unit ? `（${esc(chart.unit)}）` : ''}</figcaption><svg viewBox="0 0 300 260" role="img">${slices}</svg>${legend}</figure>`;
  }
  const all = series.flatMap((s) => (s.values || []).map(Number));
  const max = Math.max(...all, 0) * 1.1 || 1;
  const [left, top, width, height] = [48, 10, 520, 220];
  const y = (v) => top + height - (v / max) * height;
  const ticks = Array.from({ length: 5 }, (_, i) => (max / 4) * i);
  const grid = ticks.map((t) => `<line x1="${left}" x2="${left + width}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${Math.round(t * 10) / 10}</text>`).join('');
  const step = width / categories.length;
  const labels = categories.map((c, i) => `<text x="${left + step * i + step / 2}" y="${top + height + 18}" text-anchor="middle" class="axis">${esc(c)}</text>`).join('');
  let marks = '';
  if (chart.type === 'line') {
    marks = series.map((s, si) => {
      const points = (s.values || []).map((v, i) => `${left + step * i + step / 2},${y(Number(v))}`);
      return `<polyline points="${points.join(' ')}" fill="none" stroke="${palette[si % palette.length]}" stroke-width="2.5"/>${points.map((p) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3.5" fill="${palette[si % palette.length]}"/>`).join('')}`;
    }).join('');
  } else {
    const barWidth = (step * 0.7) / Math.max(1, series.length);
    marks = series.map((s, si) => (s.values || []).map((v, i) => `<rect x="${left + step * i + step * 0.15 + barWidth * si}" y="${y(Number(v))}" width="${barWidth - 2}" height="${top + height - y(Number(v))}" rx="3" fill="${palette[si % palette.length]}"><title>${esc(s.name)} ${esc(categories[i])}: ${esc(v)}</title></rect>`).join('')).join('');
  }
  return `<figure class="chart"><figcaption>${esc(chart.title)}${chart.unit ? `（${esc(chart.unit)}）` : ''}</figcaption><svg viewBox="0 0 580 260" role="img">${grid}${marks}${labels}</svg>${legend}</figure>`;
}

// 足迹页分项估分趋势。
export function trendSvg(points) {
  if (points.length < 2) return '<p class="muted">至少完成两次批改后显示趋势。</p>';
  const [left, top, width, height] = [32, 10, 540, 140];
  const x = (i) => left + (width * i) / (points.length - 1);
  const y = (v) => top + height - ((v - 3) / 6) * height;
  const grid = [4, 5, 6, 7, 8, 9].map((v) => `<line x1="${left}" x2="${left + width}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${v}</text>`).join('');
  const line = points.map((p, i) => `${x(i)},${y(p.band)}`).join(' ');
  return `<svg viewBox="0 0 580 170" class="trend">${grid}<polyline points="${line}" fill="none" stroke="#7c5cdb" stroke-width="2.5"/>${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.band)}" r="3.5" fill="#7c5cdb"><title>${esc(p.day)} ${p.band}</title></circle>`).join('')}</svg>`;
}
