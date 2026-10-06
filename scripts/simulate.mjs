// Does copying the forecast win? Plays leagues of players with different
// strategies through months of weather using the game's own question and
// scoring code (src/questions.js, src/scoring.js).
//
//   npm run simulate                 synthetic UK autumn weather
//   npm run simulate -- --real       real UK forecasts vs outcomes from
//                                    Open-Meteo's previous-runs API
//                                    (cached in scripts/sim-data/)
//   --skill=<local>,<nerd>           how much better than the forecast the
//                                    "edge" players are (default 0.08,0.15)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { questionsFor, resolveQuestion, rainChance, PRIOR_BIAS, observeFor } from '../src/questions.js';
import { scoreDay } from '../src/scoring.js';
import { biasFrom } from '../src/bias.js';
import { POPULAR } from '../src/places.js';
import { addDays } from '../src/time.js';

const SEASON_DAYS = 30;
const SEASONS = 2000;

// ---- randomness ------------------------------------------------------------

let seed = 42;
function rand() { // mulberry32: repeatable runs
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const normal = (sd = 1) => sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;
const coin = () => (rand() < 0.5 ? 1 : 0);

// ---- weather ---------------------------------------------------------------

// A city's history: [{ date, fc, obs }] in date order, where fc and obs are
// { tmax, precip, gust (km/h) }: the day-before forecast and what happened.

// Synthetic UK autumn with the biases seen in real data: highs beat the
// forecast by ~0.15°C, gusts come in ~1 mph under, rain matches the
// forecast-amount odds.
function syntheticCity(days) {
  const out = [];
  let tmax = 15;
  for (let d = 0; d < days; d++) {
    tmax = 0.7 * tmax + 0.3 * 14 + normal(2.2);
    const fcPrecip = rand() < 0.42 ? 0 : -Math.log(1 - rand()) * 4;
    const wet = rand() < rainChance(fcPrecip);
    const gust = clamp(35 + normal(14), 10, 110);
    out.push({
      date: addDays('2026-08-01', d),
      fc: { tmax: round1(tmax - 0.15 + normal(0.75)), precip: round1(fcPrecip), gust: round1(gust + 1.6 + normal(5)) },
      obs: { tmax: round1(tmax), precip: round1(wet ? 1 + -Math.log(1 - rand()) * 4 : rand() * 0.9), gust: round1(gust) },
    });
  }
  return out;
}

async function realCity(place, start, end) {
  const dir = new URL('./sim-data/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${place.id.replace(':', '-')}_${start}_${end}.json`, dir);
  let data;
  if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const vars = ['temperature_2m', 'precipitation', 'wind_gusts_10m'];
    const url = new URL('https://previous-runs-api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: place.lat, longitude: place.lon, timezone: place.tz, start_date: start, end_date: end,
      hourly: vars.flatMap((v) => [v, `${v}_previous_day1`]).join(','),
    });
    const res = await fetch(url);
    data = await res.json();
    if (!res.ok || data.error) throw new Error(`Open-Meteo: ${data.reason ?? res.status}`);
    writeFileSync(file, JSON.stringify(data));
  }
  const h = data.hourly;
  const byDay = new Map();
  h.time.forEach((t, i) => {
    const day = t.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  });
  const agg = (key, idx, fn) => {
    const vals = idx.map((i) => h[key]?.[i]).filter((v) => v != null);
    return vals.length >= 20 ? round1(fn(vals)) : null;
  };
  const max = (v) => Math.max(...v);
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  const out = [];
  for (const [date, idx] of byDay) {
    const fc = { tmax: agg('temperature_2m_previous_day1', idx, max), precip: agg('precipitation_previous_day1', idx, sum), gust: agg('wind_gusts_10m_previous_day1', idx, max) };
    const obs = { tmax: agg('temperature_2m', idx, max), precip: agg('precipitation', idx, sum), gust: agg('wind_gusts_10m', idx, max) };
    if (![...Object.values(fc), ...Object.values(obs)].some((v) => v == null)) out.push({ date, fc, obs });
  }
  return out;
}

// ---- players ---------------------------------------------------------------

// "Edge" players get a small private hint about what will really happen
// (local knowledge, watching the sky): skill = the share of the forecast's
// error they can see through.
const STRATEGIES = {
  copier: { label: 'Copies the forecast' },
  random: { label: 'Random guesser' },
  yes: { label: 'Always says yes' },
  local: { label: 'Local knowledge (small edge)', skill: 0.08, noise: 0.8 },
  sharp: { label: 'Weather nerd (bigger edge)', skill: 0.15, noise: 0.6 },
};
const skillArg = process.argv.find((a) => a.startsWith('--skill='));
if (skillArg) [STRATEGIES.local.skill, STRATEGIES.sharp.skill] = skillArg.slice(8).split(',').map(Number);
const LEAGUE = ['copier', 'copier', 'copier', 'random', 'random', 'yes', 'local', 'local', 'local', 'sharp'];

const SCALE = { temp: 1.0, wind: 4 };

// A player's picks and banker for one day's questions.
function play(kind, questions, day) {
  const s = STRATEGIES[kind];
  const picks = {};
  const edge = {};
  for (const q of questions) {
    if (kind === 'random') picks[q.key] = coin();
    else if (kind === 'yes') picks[q.key] = 1;
    else if (q.key === 'rain') {
      let p = q.chance;
      if (s.skill) p = clamp(p + s.skill * ((day.obs.precip >= 1 ? 1 : 0) - p) + normal(0.12 * s.noise), 0.01, 0.99);
      const evYes = p * q.pays.yes, evNo = (1 - p) * q.pays.no;
      picks.rain = kind === 'copier' ? (q.chance >= 0.5 ? 1 : 0) : evYes >= evNo ? 1 : 0;
      edge.rain = Math.max(evYes, evNo);
    } else {
      const truth = observeFor(q.key, day.obs);
      const est = s.skill ? q.forecast + s.skill * (truth - q.forecast) + normal(s.noise * SCALE[q.key]) : q.forecast;
      picks[q.key] = est > q.line ? 1 : 0;
      edge[q.key] = 5 + Math.abs(est - q.line);
    }
  }
  const keys = questions.map((q) => q.key);
  const banker = s.skill ? keys.reduce((a, b) => (edge[a] >= edge[b] ? a : b)) : kind === 'yes' ? 'temp' : keys[Math.floor(rand() * keys.length)];
  return { picks, banker };
}

// ---- run ---------------------------------------------------------------------

// Lines shifted by each city's own trailing 30 days (as the app does), or not at all.
function runSeasons(cities, seasons, { calibrate }) {
  const stats = Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, { pts: 0, wins: 0 }]));
  let tiedTop = 0, days = 0;
  const lineYes = { temp: [0, 0], wind: [0, 0] };
  for (let n = 0; n < seasons; n++) {
    const city = cities[Math.floor(rand() * cities.length)];
    const from = Math.floor(rand() * (city.length - SEASON_DAYS + 1));
    const totals = LEAGUE.map(() => 0);
    for (let d = from; d < from + SEASON_DAYS; d++) {
      const day = city[d];
      const history = city.slice(Math.max(0, d - 30), d).map((h) => ({
        temp: observeFor('temp', h.obs) - observeFor('temp', h.fc),
        wind: observeFor('wind', h.obs) - observeFor('wind', h.fc),
      }));
      const bias = calibrate ? biasFrom(history) : { temp: 0, wind: 0 };
      const questions = questionsFor(day.fc, bias);
      const weather = new Map([[day.date, day.obs]]);
      const results = Object.fromEntries(questions.map((q) => [q.key, resolveQuestion(q, weather, day.date)]));
      for (const k of ['temp', 'wind']) {
        if (results[k].answer != null) { lineYes[k][0] += results[k].answer; lineYes[k][1]++; }
      }
      const pts = LEAGUE.map((kind) => {
        const { picks, banker } = play(kind, questions, day);
        return scoreDay(questions, results, picks, banker).points;
      });
      pts.forEach((x, i) => { totals[i] += x; });
      const top = Math.max(...pts);
      if (pts.filter((x) => x === top).length > 1) tiedTop++;
      days++;
    }
    const top = Math.max(...totals);
    const winners = LEAGUE.filter((_, i) => totals[i] === top);
    LEAGUE.forEach((k, i) => { stats[k].pts += totals[i]; });
    for (const k of winners) stats[k].wins += 1 / winners.length;
  }
  const count = (k) => LEAGUE.filter((x) => x === k).length;
  return {
    rows: Object.entries(stats).map(([k, s]) => ({
      label: STRATEGIES[k].label, players: count(k),
      perDay: s.pts / count(k) / days,
      win: (s.wins / seasons / count(k)) * 100,
    })),
    tiedTop: (tiedTop / days) * 100,
    tempYes: (lineYes.temp[0] / lineYes.temp[1]) * 100,
    windYes: (lineYes.wind[0] / lineYes.wind[1]) * 100,
  };
}

function report(title, r) {
  console.log(`\n${title}`);
  console.log('  Strategy                          Players  Pts/day  Chance of winning the month (each)');
  for (const x of r.rows) {
    console.log(`  ${x.label.padEnd(34)}${String(x.players).padStart(4)}${x.perDay.toFixed(1).padStart(10)}${(x.win.toFixed(1) + '%').padStart(12)}`);
  }
  console.log(`  Top score shared: ${r.tiedTop.toFixed(0)}% of days · temperature line answered YES ${r.tempYes.toFixed(0)}% · wind line YES ${r.windYes.toFixed(0)}% (50% is a fair coin)`);
}

const real = process.argv.includes('--real');
let cities;
if (real) {
  const end = addDays(new Date().toISOString().slice(0, 10), -2);
  const start = addDays(end, -59);
  cities = [];
  for (const place of POPULAR) {
    try {
      const days = await realCity(place, start, end);
      if (days.length >= SEASON_DAYS) cities.push(days);
    } catch (err) {
      console.error(`${place.name}: ${err.message}`);
    }
  }
  if (!cities.length) process.exit(1);
  console.log(`Real data: ${cities.length} UK cities, ${start} to ${end}`);
} else {
  cities = Array.from({ length: 20 }, () => syntheticCity(90));
  console.log('Synthetic UK autumn weather (biased like the real data)');
}
const seasons = real ? 1000 : SEASONS;
console.log(`${seasons} simulated months, leagues of ${LEAGUE.length}. Prior bias: highs ${PRIOR_BIAS.temp}°C, gusts ${PRIOR_BIAS.wind} mph.`);
report('Lines exactly on the forecast (no calibration)', runSeasons(cities, seasons, { calibrate: false }));
report('Lines shifted by each city\'s recent bias (what the app does)', runSeasons(cities, seasons, { calibrate: true }));
