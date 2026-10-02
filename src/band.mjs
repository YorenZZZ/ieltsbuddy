// 雅思分数换算。总分与分项平均按官方规则就近取 0.5：.25 进到 .5，.75 进到下一整数。
export function roundBand(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction < 0.25 ? floor : fraction < 0.75 ? floor + 0.5 : floor + 1;
}

const tables = {
  listening: [[39, 9], [37, 8.5], [35, 8], [32, 7.5], [30, 7], [26, 6.5], [23, 6], [18, 5.5], [16, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5], [0, 0]],
  reading: [[39, 9], [37, 8.5], [35, 8], [33, 7.5], [30, 7], [27, 6.5], [23, 6], [19, 5.5], [15, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5], [0, 0]],
};

// 题量不足 40 时按比例折算到 40 题再查表，只作估算。
export function rawToBand(correct, total, skill) {
  if (!total) return null;
  const scaled = Math.round((correct / total) * 40);
  return tables[skill].find(([min]) => scaled >= min)[1];
}

const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const aliases = { t: 'true', f: 'false', ng: 'not given', y: 'yes', n: 'no' };

export function isCorrect(given, accepted) {
  const answer = normalize(given);
  if (!answer) return false;
  const expanded = aliases[answer] || answer;
  return [].concat(accepted).some((option) => {
    const target = normalize(option);
    return target === expanded || target === answer;
  });
}

export function scoreObjective(questions, answers, key) {
  const items = questions.map((question) => {
    const accepted = key[question.id] ?? [];
    const correct = isCorrect(answers[question.id], accepted);
    return { id: question.id, given: answers[question.id] ?? '', accepted: [].concat(accepted), correct };
  });
  return { items, correct: items.filter((item) => item.correct).length, total: items.length };
}
