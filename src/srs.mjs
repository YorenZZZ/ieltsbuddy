// SM-2 间隔复习。grade：1 忘了 / 3 模糊 / 4 记得 / 5 简单。
import { addDays, todayKey } from './util.mjs';

export function reviewCard(card, grade, today = todayKey()) {
  let { ease = 2.5, interval_days: interval = 0, reps = 0, lapses = 0 } = card;
  if (grade < 3) {
    reps = 0;
    interval = 1;
    lapses += 1;
  } else {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.max(1, Math.round(interval * ease));
  }
  ease = Math.max(1.3, Math.round((ease + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)) * 100) / 100);
  return { ease, interval_days: interval, reps, lapses, due_at: addDays(today, interval) };
}
