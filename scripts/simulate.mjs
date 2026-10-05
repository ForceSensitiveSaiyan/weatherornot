// Does copying the forecast win? Simulates leagues of players with different
// strategies over a month of weather, under the current scoring (A) and the
// proposed "forecast is the line" design (B).
//
//   node scripts/simulate.mjs              synthetic UK autumn weather
//   node scripts/simulate.mjs --real       real UK forecasts vs outcomes from
//                                          Open-Meteo's previous-runs API
//                                          (cached in scripts/sim-data/)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { questionsFor, resolveQuestion } from '../src/questions.js';
import { POPULAR } from '../src/places.js';
import { addDays } from '../src/time.js';

const SEASON_DAYS = 30;
const SEASONS = 2000;
const KMH_PER_MPH = 1.609344;

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

// ---- weather ---------------------------------------------------------------

// A day is { fc, obs, todayObs, todayFc }, each with tmax/tmin/precip/snow/gust
// (km/h, as the providers give it), plus rainProb: the forecast chance of
// at least 1 mm.
//
// Synthetic UK autumn: next-day max temperature forecast error ~1.4°C,
// gust error ~8 km/h, and rain chances that are often confident (near 0 or
// 1) and calibrated, so "70%" really does rain 70% of the time.
function syntheticSeason() {
  const days = [];
  let tmax = 15 + normal(2);
  for (let d = 0; d < SEASON_DAYS + 1; d++) {
    const prev = tmax;
    tmax = 0.7 * tmax + 0.3 * 14 + normal(2.2);
    const rainProb = clamp(betaish(), 0.02, 0.98);
    const wet = rand() < rainProb;
    const precip = wet ? 1 + -Math.log(1 - rand()) * 5 : rand() * 0.8;
    const gust = clamp(35 + normal(14), 10, 110);
    const obs = { tmax: round1(tmax), tmin: round1(tmax - 7), precip: round1(precip), snow: 0, gust: round1(gust) };
    const fc = {
      tmax: round1(tmax + normal(1.4)),
      tmin: obs.tmin,
      precip: round1(rainProb >= 0.5 ? Math.max(1, precip * Math.exp(normal(0.5))) : rand() * 0.8),
      snow: 0,
      gust: round1(clamp(gust + normal(8), 5, 120)),
    };
    days.push({ fc, obs, rainProb, prevObsTmax: round1(prev), prevFcTmax: round1(prev + normal(0.8)) });
  }
  return days.slice(1);
}
// U-shaped chance of rain: forecasts are usually fairly sure either way.
function betaish() {
  const u = rand();
  return u < 0.35 ? rand() * 0.2 : u < 0.7 ? 0.8 + rand() * 0.2 : rand();
}

// Real data: hourly forecasts made the day before (…_previous_day1) and the
// latest values (what happened), aggregated to days in UK time.
async function realDays(place, start, end) {
  const dir = new URL('./sim-data/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${place.id.replace(':', '-')}_${start}_${end}.json`, dir);
  let data;
  if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const vars = ['temperature_2m', 'precipitation', 'wind_gusts_10m', 'precipitation_probability'];
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
    return vals.length >= 20 ? fn(vals) : null;
  };
  const max = (v) => Math.max(...v);
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  const days = [];
  for (const [day, idx] of byDay) {
    const prev = byDay.get(addDays(day, -1));
    const obs = { tmax: agg('temperature_2m', idx, max), precip: agg('precipitation', idx, sum), gust: agg('wind_gusts_10m', idx, max) };
    const fc = {
      tmax: agg('temperature_2m_previous_day1', idx, max),
      precip: agg('precipitation_previous_day1', idx, sum),
      gust: agg('wind_gusts_10m_previous_day1', idx, max),
    };
    const prob = agg('precipitation_probability_previous_day1', idx, max);
    if (!prev || Object.values({ ...obs, ...fc }).some((v) => v == null)) continue;
    const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round1(v)]));
    days.push({
      fc: { ...r(fc), tmin: 10, snow: 0 },
      obs: { ...r(obs), tmin: 10, snow: 0 },
      // Hourly max probability overstates the chance of 1 mm over the day; fall back
      // to the forecast amount when the model has no probabilities.
      rainProb: prob != null ? clamp(prob / 100, 0.02, 0.98) : fc.precip >= 1 ? 0.75 : 0.15,
      prevObsTmax: round1(agg('temperature_2m', prev, max)),
      prevFcTmax: round1(agg('temperature_2m_previous_day1', prev, max)),
    });
  }
  return days;
}

// ---- players ---------------------------------------------------------------

// Each strategy sees the forecast; "local" players also get a small private
// hint about what will really happen (knowing their area, watching the sky).
// skill = how much of the forecast's error they can see through.
const STRATEGIES = {
  copier: { label: 'Copies the forecast', skill: 0, noise: 0 },
  random: { label: 'Random guesser', random: true },
  contrarian: { label: 'Always against the forecast', contrarian: true },
  // Beating a modern forecast is hard, so the edges are small by default.
  // Override with --skill=<local>,<nerd>, e.g. --skill=0.3,0.5.
  local: { label: 'Local knowledge (small edge)', skill: 0.08, noise: 0.8 },
  sharp: { label: 'Weather nerd (bigger edge)', skill: 0.15, noise: 0.6 },
};
const skillArg = process.argv.find((a) => a.startsWith('--skill='));
if (skillArg) [STRATEGIES.local.skill, STRATEGIES.sharp.skill] = skillArg.slice(8).split(',').map(Number);
const LEAGUE = ['copier', 'copier', 'copier', 'random', 'random', 'contrarian', 'local', 'local', 'local', 'sharp'];

// A player's private estimate of a value, pulled from the forecast toward the truth.
const estimate = (s, fc, truth, scale) => fc + s.skill * (truth - fc) + normal(s.noise * scale);
function rainBelief(s, day) {
  const truth = day.obs.precip >= 1 ? 1 : 0;
  return clamp(day.rainProb + s.skill * (truth - day.rainProb) + normal(0.15 * (s.noise ?? 0)), 0.01, 0.99);
}

// ---- design A: what's live now ---------------------------------------------

function playA(day, players) {
  const tomorrow = day.fc;
  const today = { ...day.fc, tmax: day.prevFcTmax };
  const questions = questionsFor(tomorrow, today);
  const weather = new Map([['D', day.obs], ['C', { ...day.obs, tmax: day.prevObsTmax }]]);
  const picks = players.map((s) => questions.map((q) => {
    if (s.random) return rand() < 0.5 ? 1 : 0;
    if (s.contrarian) return 1 - q.forecastSays;
    if (!s.skill) return q.forecastSays;
    if (q.key === 'rain') return rainBelief(s, day) >= 0.5 ? 1 : 0;
    if (q.key === 'snow') return q.forecastSays;
    const truth = q.key === 'wind' ? day.obs.gust / KMH_PER_MPH : day.obs.tmax;
    const fc = q.key === 'wind' ? day.fc.gust / KMH_PER_MPH : day.fc.tmax;
    const est = estimate(s, fc, truth, q.key === 'wind' ? 4 : 1.2);
    return est > q.line ? 1 : 0;
  }));
  return players.map((_, p) => questions.reduce((pts, q, i) => {
    const res = resolveQuestion(q, new Map([['2026-10-06', weather.get('D')], ['2026-10-05', weather.get('C')]]), '2026-10-06');
    const pick = picks[p][i];
    if (pick !== res.answer) return pts;
    const share = picks.filter((x) => x[i] === pick).length / picks.length;
    return pts + 10 + (pick !== q.forecastSays ? 10 : 0) + (share <= 1 / 3 ? 5 : 0);
  }, 0));
}

// ---- design B: the forecast is the line ------------------------------------

// Odds-style points for rain: a right call on a side the forecast gives
// chance q pays 5/q, so either side is worth 5 on average if you only know
// the forecast. Capped so long shots stay sane.
const pays = (q) => clamp(Math.round(5 / q), 1, 50);

function playB(day, players, { nearest = true } = {}) {
  const tempLine = round1(day.fc.tmax);
  const windLine = round1(day.fc.gust / KMH_PER_MPH);
  const truthWind = day.obs.gust / KMH_PER_MPH;
  const rainYes = day.obs.precip >= 1 ? 1 : 0;
  const payYes = pays(day.rainProb);
  const payNo = pays(1 - day.rainProb);
  const scores = players.map((s) => {
    let pts = 0;
    // Rain at odds.
    let rain;
    if (s.random) rain = rand() < 0.5 ? 1 : 0;
    else if (s.contrarian) rain = day.rainProb >= 0.5 ? 0 : 1;
    else if (!s.skill) rain = day.rainProb >= 0.5 ? 1 : 0;
    else { const b = rainBelief(s, day); rain = b * payYes >= (1 - b) * payNo ? 1 : 0; }
    if (rain === rainYes) pts += rain ? payYes : payNo;
    // Temperature and wind lines sit on the forecast: 10 for a right call.
    for (const [fc, truth, line, scale] of [[day.fc.tmax, day.obs.tmax, tempLine, 1.2], [day.fc.gust / KMH_PER_MPH, truthWind, windLine, 4]]) {
      let pick;
      if (s.random || s.contrarian) pick = rand() < 0.5 ? 1 : 0; // no "against" when the forecast is the line
      else if (!s.skill) pick = rand() < 0.5 ? 1 : 0;           // the forecast is a coin flip here
      else pick = estimate(s, fc, truth, scale) > line ? 1 : 0;
      if (pick === (truth > line ? 1 : 0)) pts += 10;
    }
    return pts;
  });
  if (!nearest) return scores;
  // Nearest guess on tomorrow's high: up to 20 for being close, +10 for closest.
  const guesses = players.map((s) => {
    if (s.random) return round1(day.fc.tmax + normal(3));
    if (s.contrarian) return round1(day.fc.tmax + (rand() < 0.5 ? -2 : 2));
    return round1(estimate(s, day.fc.tmax, day.obs.tmax, 1.2));
  });
  const errs = guesses.map((g) => Math.abs(g - day.obs.tmax));
  const best = Math.min(...errs);
  const winners = errs.filter((e) => e === best).length;
  return scores.map((pts, p) => pts + Math.max(0, Math.round(20 - 8 * errs[p])) + (errs[p] === best ? Math.round(10 / winners) : 0));
}

// ---- run ---------------------------------------------------------------------

function runSeasons(getSeason, play, seasons) {
  const stats = Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, { pts: 0, wins: 0, n: 0 }]));
  let tiedTopDays = 0, days = 0, spread = 0;
  for (let n = 0; n < seasons; n++) {
    const players = LEAGUE.map((k) => STRATEGIES[k]);
    const totals = players.map(() => 0);
    for (const day of getSeason(n)) {
      const pts = play(day, players);
      pts.forEach((x, i) => { totals[i] += x; });
      const top = Math.max(...pts);
      if (pts.filter((x) => x === top).length > 1) tiedTopDays++;
      days++;
    }
    const top = Math.max(...totals);
    const winners = LEAGUE.filter((_, i) => totals[i] === top);
    LEAGUE.forEach((k, i) => { stats[k].pts += totals[i]; stats[k].n++; });
    for (const k of winners) stats[k].wins += 1 / winners.length;
    const mean = totals.reduce((a, b) => a + b) / totals.length;
    spread += Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length) / mean;
  }
  const count = (k) => LEAGUE.filter((x) => x === k).length;
  return {
    rows: Object.entries(stats).map(([k, s]) => ({
      strategy: STRATEGIES[k].label,
      players: count(k),
      perDay: s.pts / s.n / (days / seasons),
      // Fair share is 10% each in a 10-player league.
      winChancePerPlayer: (s.wins / seasons / count(k)) * 100,
    })),
    tiedTopDays: (tiedTopDays / days) * 100,
    spread: (spread / seasons) * 100,
  };
}

function report(title, result) {
  console.log(`\n${title}`);
  console.log('  Strategy                          Players  Pts/day  Chance of winning the month (each)');
  for (const r of result.rows) {
    console.log(`  ${r.strategy.padEnd(34)}${String(r.players).padStart(4)}${r.perDay.toFixed(1).padStart(10)}${(r.winChancePerPlayer.toFixed(1) + '%').padStart(12)}`);
  }
  console.log(`  Days where the top score is shared: ${result.tiedTopDays.toFixed(0)}%   Score spread: ${result.spread.toFixed(0)}% of the average`);
}

const real = process.argv.includes('--real');
let seasonsData;
if (real) {
  const end = addDays(new Date().toISOString().slice(0, 10), -2);
  const start = addDays(end, -59);
  seasonsData = [];
  for (const place of POPULAR) {
    try {
      const days = await realDays(place, start, end);
      if (days.length >= SEASON_DAYS) seasonsData.push({ place: place.name, days });
    } catch (err) {
      console.error(`${place.name}: ${err.message}`);
    }
  }
  if (!seasonsData.length) process.exit(1);
  console.log(`Real data: ${seasonsData.length} UK cities, ${start} to ${end}`);
  const forecastHit = seasonsData.flatMap((s) => s.days).map((d) => (d.rainProb >= 0.5) === (d.obs.precip >= 1));
  console.log(`Next-day rain forecast right: ${((forecastHit.filter(Boolean).length / forecastHit.length) * 100).toFixed(0)}% of days`);
} else {
  console.log(`Synthetic UK autumn weather, ${SEASONS} simulated months, leagues of ${LEAGUE.length}`);
}

// Real data: each "season" is a random 30-day stretch from a random city.
const pickSeason = real
  ? () => {
      const s = seasonsData[Math.floor(rand() * seasonsData.length)];
      const from = Math.floor(rand() * (s.days.length - SEASON_DAYS + 1));
      return s.days.slice(from, from + SEASON_DAYS);
    }
  : () => syntheticSeason();

report('A. Current design (rain / warmer than today / wildcard, +10 beat the forecast, +5 bold call)',
  runSeasons(pickSeason, playA, real ? 1000 : SEASONS));
report('B without the nearest guess (just the three calls)',
  runSeasons(pickSeason, (d, p) => playB(d, p, { nearest: false }), real ? 1000 : SEASONS));
report('B. Forecast is the line (rain at odds, temperature and wind lines on the forecast, nearest-guess high)',
  runSeasons(pickSeason, playB, real ? 1000 : SEASONS));
