// Scoring one player's day. Shared by the game and the simulator.
//
// A right call earns what that side pays (odds for rain, 10 for the lines).
// A void call (the weather landed exactly on the line) earns 5 for everyone
// who made it. Your "banker" call, one a day, counts double.
export const VOID_POINTS = 5;
export const MAX_POINTS = Infinity;

export function scoreDay(questions, results, picks, banker, { cap = MAX_POINTS } = {}) {
  const detail = {};
  let correct = 0;
  let points = 0;
  for (const q of questions) {
    const pick = picks[q.key];
    if (pick == null) continue;
    const { answer } = results[q.key];
    const doubled = banker === q.key;
    let p;
    if (answer == null) p = VOID_POINTS;
    else if (pick === answer) {
      p = pick ? q.pays.yes : q.pays.no;
      correct++;
    } else p = 0;
    if (doubled) p = Math.min(p * 2, cap);
    points += p;
    detail[q.key] = { pick, correct: answer == null ? null : pick === answer, points: p, banker: doubled };
  }
  return { correct, points, detail };
}
