import test from 'node:test';
import assert from 'node:assert/strict';
import { roundBand, rawToBand, isCorrect, scoreObjective } from '../src/band.mjs';
import { reviewCard } from '../src/srs.mjs';
import { clozeSegment, splitSentences } from '../src/cloze.mjs';
import { extractJson } from '../src/llm.mjs';
import { markdown } from '../public/js/md.js';

test('雅思总分按官方规则取整', () => {
  assert.equal(roundBand(6.125), 6);
  assert.equal(roundBand(6.25), 6.5);
  assert.equal(roundBand(6.625), 6.5);
  assert.equal(roundBand(6.75), 7);
});

test('听力阅读原始分按 40 题比例换算', () => {
  assert.equal(rawToBand(30, 40, 'listening'), 7);
  assert.equal(rawToBand(30, 40, 'reading'), 7);
  assert.equal(rawToBand(10, 10, 'listening'), 9);
  assert.equal(rawToBand(13, 13, 'reading'), 9);
  assert.equal(rawToBand(0, 0, 'reading'), null);
});

test('客观题判分容忍大小写、标点与 T/F/NG 缩写', () => {
  assert.ok(isCorrect('ng', ['NOT GIVEN']));
  assert.ok(isCorrect(' The Museum. ', ['the museum']));
  assert.ok(!isCorrect('', ['A']));
  const score = scoreObjective([{ id: '1' }, { id: '2' }], { 1: 'b', 2: 'x' }, { 1: ['B'], 2: ['42', 'forty-two'] });
  assert.equal(score.correct, 1);
  assert.equal(score.total, 2);
});

test('SM-2：答对拉长间隔，忘记重置为 1 天', () => {
  let card = { ease: 2.5, interval_days: 0, reps: 0, lapses: 0 };
  card = reviewCard(card, 4, '2026-10-02');
  assert.equal(card.interval_days, 1);
  assert.equal(card.due_at, '2026-10-03');
  card = reviewCard(card, 4, '2026-10-03');
  assert.equal(card.interval_days, 6);
  card = reviewCard(card, 5, '2026-10-09');
  assert.ok(card.interval_days >= 15);
  card = reviewCard(card, 1, '2026-10-30');
  assert.equal(card.interval_days, 1);
  assert.equal(card.lapses, 1);
  assert.ok(card.ease >= 1.3);
});

test('精听挖空优先数字，拼回后与原句一致', () => {
  const text = 'The tour starts at 9.30 from the main entrance, near the library.';
  const { parts, answers } = clozeSegment(text);
  assert.equal(answers[0], '9.30');
  assert.equal(answers.length, 2);
  assert.equal(parts.map((p) => (p.text != null ? p.text : answers[p.blank])).join(''), text);
  assert.deepEqual(splitSentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!']);
});

test('从模型输出中提取 JSON（容忍代码块与字符串内括号）', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a": "x}y", "b": {"c": 1}}\n```'), { a: 'x}y', b: { c: 1 } });
  assert.throws(() => extractJson('没有 JSON'));
});

test('Markdown 渲染转义 HTML，只放行 http 链接', () => {
  const out = markdown('# 标题\n<script>alert(1)</script>\n[x](javascript:alert(1)) [ok](https://example.com)');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('href="javascript'));
  assert.ok(out.includes('href="https://example.com"'));
});
