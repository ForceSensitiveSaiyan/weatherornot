// The daily calls. The forecast sets the line instead of giving the answer,
// so copying it is no better than a coin flip:
//
// - Rain pays odds from the forecast's real chance of rain: a right call on
//   a side with chance q pays about 5/q, worth 5 on average either way if
//   all you know is the forecast.
// - Temperature and wind ask "over or under?" with the line on the forecast,
//   shifted by how that place's forecasts have been running lately (highs in
//   most UK cities beat the forecast more often than not), and pay 10.
//
// See scripts/simulate.mjs and ROADMAP.md (Phase 1) for the evidence.

const KMH_PER_MPH = 1.609344;
const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// How often a weather station actually recorded 1 mm or more, by the
// day-before forecast amount. Open-Meteo forecasts vs the nearest station's
// SYNOP reports for 15 UK and Isle of Man places, Aug to Oct 2026 (878 days),
// lightly smoothed. Rerun with `npm run simulate -- --real --station`.
const RAIN_CHANCE = [
  [0.1, 0.04], [0.3, 0.2], [1, 0.34], [1.5, 0.47], [2.5, 0.56], [4, 0.72], [7, 0.78], [Infinity, 0.91],
];
export const rainChance = (mm) => RAIN_CHANCE.find(([below]) => mm < below)[1];

// Odds-style points: 5 / chance, kept between 1 and 50 so long shots stay sane.
export const pays = (chance) => clamp(Math.round(5 / chance), 1, 50);
export const LINE_POINTS = 10;

// How far station readings ran above the day-before forecast, on average,
// across the same places. Used until a place has its own history.
export const PRIOR_BIAS = { temp: 0.35, wind: 0.2 };

const KINDS = {
  rain: {
    emoji: '☔️',
    title: () => 'Will it rain?',
    detail: () => 'At least 1 mm during the day',
    observe: (day) => day?.precip,
    unit: 'mm',
  },
  temp: {
    emoji: '🌡️',
    title: (line) => `Will it top ${line}°C?`,
    detail: () => "Tomorrow's high",
    observe: (day) => day?.tmax,
    unit: '°C',
  },
  wind: {
    emoji: '💨',
    title: (line) => `Gusts over ${line} mph?`,
    detail: () => 'Strongest gust of the day',
    observe: (day) => (day?.gust == null ? null : round1(day.gust / KMH_PER_MPH)),
    unit: 'mph',
  },
};

// Questions for tomorrow from its forecast. `bias` is how far this place's
// observed values have recently run above the forecast ({ temp, wind }).
export function questionsFor(tomorrow, bias = PRIOR_BIAS) {
  const chance = rainChance(tomorrow.precip);
  const gust = KINDS.wind.observe(tomorrow);
  return [
    { key: 'rain', forecast: tomorrow.precip, line: 1, chance, pays: { yes: pays(chance), no: pays(1 - chance) } },
    { key: 'temp', forecast: tomorrow.tmax, bias: round1(bias.temp), line: round1(tomorrow.tmax + bias.temp),
      pays: { yes: LINE_POINTS, no: LINE_POINTS } },
    { key: 'wind', forecast: gust, bias: round1(bias.wind), line: round1(gust + bias.wind),
      pays: { yes: LINE_POINTS, no: LINE_POINTS } },
  ];
}

// { answer: 1 | 0 | null, observed } once the day's data is in; answer is
// null (a void call) when the observed value lands exactly on the line.
// Returns null while the data isn't available yet.
export function resolveQuestion(q, weather, date) {
  const observed = KINDS[q.key].observe(weather.get(date));
  if (observed == null) return null;
  if (q.key === 'rain') return { answer: observed >= q.line ? 1 : 0, observed };
  return { answer: observed === q.line ? null : observed > q.line ? 1 : 0, observed };
}

export function describeQuestion(q) {
  const kind = KINDS[q.key];
  return { ...q, emoji: kind.emoji, title: kind.title(q.line), detail: kind.detail(q.line), unit: kind.unit };
}

export const observeFor = (key, day) => KINDS[key].observe(day);
