// The three calls in each daily game: rain, warmer-than-today, and a wildcard
// picked from tomorrow's forecast (snow when it's cold, heat when it's hot,
// otherwise wind). Each question records what the forecast implied, so
// players who beat the forecast can be rewarded.
import { addDays } from './time.js';

const f = (c) => Math.round(c * 9 / 5 + 32);
const roundTo = (x, step) => Math.round(x / step) * step;

const KINDS = {
  rain: {
    emoji: '☔',
    title: () => 'Will it rain?',
    detail: () => 'At least 1 mm of rain during the day',
    line: () => 1,
    observe: (day) => day?.precip,
    yes: (value, line) => value >= line,
    unit: 'mm',
  },
  warmer: {
    emoji: '🌡️',
    title: () => 'Warmer than today?',
    detail: () => "Tomorrow's high beats today's high",
    line: (tomorrow, today) => today.tmax,
    observe: (day) => day?.tmax,
    // The line is today's *actual* high, known only once today is over.
    actualLine: (weather, date) => weather.get(addDays(date, -1))?.tmax,
    yes: (value, line) => value > line,
    unit: '°C',
  },
  snow: {
    emoji: '❄️',
    title: () => 'Will it snow?',
    detail: () => 'At least 0.5 cm of snow',
    line: () => 0.5,
    observe: (day) => day?.snow,
    yes: (value, line) => value >= line,
    unit: 'cm',
  },
  heat: {
    emoji: '🥵',
    title: (line) => `Will it hit ${line}°C (${f(line)}°F)?`,
    detail: () => 'Highest temperature of the day',
    line: (tomorrow) => Math.max(25, roundTo(tomorrow.tmax, 5)),
    observe: (day) => day?.tmax,
    yes: (value, line) => value >= line,
    unit: '°C',
  },
  wind: {
    emoji: '💨',
    title: (line) => `Gusts over ${line} km/h?`,
    detail: () => 'Strongest wind gust of the day',
    line: (tomorrow) => Math.max(30, roundTo(tomorrow.gust, 10)),
    observe: (day) => day?.gust,
    yes: (value, line) => value > line,
    unit: 'km/h',
  },
};

function wildcard(tomorrow) {
  if (tomorrow.snow > 0 || tomorrow.tmin <= 1) return 'snow';
  if (tomorrow.tmax >= 24) return 'heat';
  return 'wind';
}

// Questions for tomorrow, from tomorrow's and today's forecasts.
export function questionsFor(tomorrow, today) {
  return ['rain', 'warmer', wildcard(tomorrow)].map((key) => {
    const kind = KINDS[key];
    const line = Math.round(kind.line(tomorrow, today) * 10) / 10;
    const forecast = kind.observe(tomorrow);
    return { key, line, forecast, forecastSays: kind.yes(forecast, line) ? 1 : 0 };
  });
}

// { answer: 1|0, observed, line } or null while the data isn't in yet.
export function resolveQuestion(q, weather, date) {
  const kind = KINDS[q.key];
  const observed = kind.observe(weather.get(date));
  const line = kind.actualLine ? kind.actualLine(weather, date) : q.line;
  if (observed == null || line == null) return null;
  return { answer: kind.yes(observed, line) ? 1 : 0, observed, line };
}

export function describeQuestion(q) {
  const kind = KINDS[q.key];
  return { ...q, emoji: kind.emoji, title: kind.title(q.line), detail: kind.detail(q.line), unit: kind.unit };
}
