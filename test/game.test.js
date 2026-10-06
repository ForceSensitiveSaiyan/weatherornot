import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createGame } from '../src/game.js';
import { scoreDay } from '../src/scoring.js';
import { questionsFor, resolveQuestion } from '../src/questions.js';
import { mockGeocoder, openMeteoGeocoder } from '../src/places.js';
import { fetchWithRetry } from '../src/weather.js';

const LONDON = 'gn:2643743';
const mild = { tmax: 17.8, tmin: 9, precip: 3.2, snow: 0, gust: 41, code: 61 };

function setup({ today = { ...mild, tmax: 16 }, tomorrow = mild } = {}) {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const weather = new Map([['2026-10-05', today], ['2026-10-06', tomorrow]]);
  const game = createGame({
    db: openDb(), provider: { daily: async () => weather }, geocoder: mockGeocoder(), now: () => clock.now,
  });
  const player = () => game.userForToken(game.createGuest());
  return { game, clock, weather, player };
}

test('the forecast sets the line: rain pays odds, temperature and wind lines shift by bias', () => {
  const [rain, temp, wind] = questionsFor(mild, { temp: 0.2, wind: -1 });
  // 3.2 mm forecast: stations saw rain 72% of the time, so YES pays 5/0.72 and NO 5/0.28.
  assert.deepEqual([rain.chance, rain.pays], [0.72, { yes: 7, no: 18 }]);
  assert.deepEqual([temp.line, temp.pays], [18, { yes: 10, no: 10 }]);
  // 41 km/h is 25.5 mph; gusts have been coming in 1 mph under.
  assert.deepEqual([wind.forecast, wind.line], [25.5, 24.5]);
  // A dry forecast makes rain a long shot, capped at 50.
  const [dry] = questionsFor({ ...mild, precip: 0 });
  assert.deepEqual(dry.pays, { yes: 50, no: 5 });
});

test('landing exactly on a line voids the call: 5 points, doubled for a banker', () => {
  const questions = questionsFor(mild, { temp: 0.2, wind: -1 });
  const weather = new Map([['2026-10-06', { tmax: 18, precip: 0, gust: 80.5 }]]);
  const results = Object.fromEntries(questions.map((q) => [q.key, resolveQuestion(q, weather, '2026-10-06')]));
  assert.deepEqual(results, {
    rain: { answer: 0, observed: 0 }, temp: { answer: null, observed: 18 }, wind: { answer: 1, observed: 50 },
  });
  const { correct, points, detail } = scoreDay(questions, results, { rain: 0, temp: 1, wind: 1 }, 'temp');
  // NO on rain pays 18, temperature is void (5, doubled), wind YES pays 10.
  assert.deepEqual([correct, points, detail.temp.points, detail.temp.correct], [2, 18 + 10 + 10, 10, null]);
  assert.equal(resolveQuestion(questions[0], new Map(), '2026-10-06'), null);
});

test('a full day: pick, bank, lock at local midnight, settle, score, recalibrate', async () => {
  const { game, clock, weather, player } = setup();
  const view = await game.view(null, LONDON);
  assert.equal(view.round.date, '2026-10-06');
  assert.equal(view.round.number, 6);
  assert.equal(view.round.closesAt, '2026-10-05T23:00:00.000Z');
  const [rain, temp, wind] = view.round.questions;
  assert.deepEqual([rain.key, temp.key, wind.key], ['rain', 'temp', 'wind']);
  assert.equal(temp.title, `Will it top ${temp.line}°C?`);
  assert.equal(temp.line, 18.2); // 17.8 forecast + the prior of +0.35, to one decimal

  const ann = player();
  const ben = player();
  const id = view.round.id;
  game.makePick(ann.id, id, 'rain', 1);
  game.makePick(ann.id, id, 'temp', 0);
  game.makePick(ann.id, id, 'wind', 0);
  assert.equal(game.setBanker(ann.id, id, 'rain').banker, 'rain');
  for (const key of ['rain', 'temp', 'wind']) game.makePick(ben.id, id, key, key === 'rain' ? 0 : 1);
  assert.throws(() => game.makePick(ann.id, id, 'snow', 1), /No such question/);

  clock.now = new Date('2026-10-05T23:30:00Z'); // past midnight in London
  assert.throws(() => game.makePick(ben.id, id, 'wind', 0), /locked/);
  assert.throws(() => game.setBanker(ben.id, id, 'wind'), /locked/);
  assert.equal(await game.settleRounds(), 0);

  clock.now = new Date('2026-10-07T07:00:00Z');
  weather.set('2026-10-06', { ...mild, tmax: 15.5, precip: 6, gust: 35 }); // wet, cooler, calmer
  weather.set('2026-10-08', mild);
  assert.equal(await game.settleRounds(), 1);
  assert.equal(await game.settleRounds(), 0);

  const annView = await game.view(ann.id, LONDON);
  // Ann: rain YES pays 7, doubled as her banker; temperature and wind NO pay 10 each.
  assert.deepEqual(annView.lastRound.score, { correct: 3, points: 14 + 10 + 10 });
  assert.equal(annView.lastRound.questions[0].score.banker, true);
  assert.deepEqual((await game.view(ben.id, LONDON)).lastRound.score, { correct: 0, points: 0 });
  assert.deepEqual(annView.leaderboard.map((r) => r.points), [34, 0]);

  // London's high came in 2.3°C under the forecast, so the next adjustment shrinks:
  // (-2.3 + 10 days' worth of the +0.35 prior) / 11 = +0.11.
  assert.equal(annView.round.date, '2026-10-08');
  assert.equal(annView.round.questions[1].line, 17.9);
  assert.deepEqual(annView.lastRound.source, { type: 'model' });
});

test('the banker can move between calls and be cleared', async () => {
  const { game, player } = setup();
  const { round } = await game.view(null, LONDON);
  const u = player();
  assert.equal(game.setBanker(u.id, round.id, 'temp').banker, 'temp');
  assert.equal(game.setBanker(u.id, round.id, 'wind').banker, 'wind');
  assert.equal(game.setBanker(u.id, round.id, null).banker, null);
  assert.throws(() => game.setBanker(u.id, round.id, 'snow'), /No such question/);
});

test('guests can play, then save their account and log in elsewhere', () => {
  const { game } = setup();
  const token = game.createGuest();
  const guest = game.userForToken(token);
  assert.equal(guest.guest, true);
  assert.match(guest.name, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/);
  assert.throws(() => game.login(guest.name, ''), /Wrong name/);

  game.saveAccount(guest.id, 'keith', 'secret1');
  assert.deepEqual(game.userForToken(token), { id: guest.id, name: 'keith', guest: false });
  assert.throws(() => game.saveAccount(guest.id, 'keith2', 'secret1'), /already saved/);
  assert.equal(game.userForToken(game.login('KEITH', 'secret1')).id, guest.id);

  const other = game.userForToken(game.createGuest());
  assert.throws(() => game.saveAccount(other.id, 'Keith', 'secret2'), /taken/);
});

test('streak counts consecutive days played', async () => {
  const { game, clock, weather, player } = setup();
  const u = player();
  const playDay = async (iso, today, tomorrow) => {
    clock.now = new Date(iso);
    weather.set(today, mild);
    weather.set(tomorrow, mild);
    const { round } = await game.view(u.id, LONDON);
    game.makePick(u.id, round.id, 'rain', 1);
  };
  await playDay('2026-10-05T12:00:00Z', '2026-10-05', '2026-10-06');
  await playDay('2026-10-06T12:00:00Z', '2026-10-06', '2026-10-07');
  await playDay('2026-10-07T12:00:00Z', '2026-10-07', '2026-10-08');
  assert.equal(game.stats(u.id).streak, 3);
  clock.now = new Date('2026-10-10T12:00:00Z');
  assert.equal(game.stats(u.id).streak, 0);
});

test('leagues: create, preview the invite, join, leave', () => {
  const { game, player } = setup();
  const ann = player();
  const ben = player();
  const league = game.createLeague(ann.id, '  Office Forecasters ');
  assert.match(league.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(game.leaguePreview(league.code.toLowerCase()),
    { name: 'Office Forecasters', code: league.code, members: 1, owner: ann.name });
  game.joinLeague(ben.id, league.code);
  game.joinLeague(ben.id, league.code);
  assert.equal(game.myLeagues(ann.id)[0].standings.length, 2);
  game.leaveLeague(ben.id, league.id);
  assert.deepEqual(game.myLeagues(ben.id), []);
  assert.throws(() => game.joinLeague(ben.id, 'NOPE00'), /No league/);
});

test('place search saves results so they can be played', async () => {
  const { game } = setup();
  const [manchester] = await game.searchPlaces('manc');
  assert.equal(manchester.name, 'Manchester');
  assert.deepEqual(await game.searchPlaces('x'), []);
  await assert.rejects(game.view(null, 'gn:nope'), /Unknown place/);
});

test('an old points-betting database is refused with a clear message', (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'won-')), 'old.db');
  t.after(() => rmSync(path, { force: true }));
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE markets (id INTEGER PRIMARY KEY)');
  old.close();
  assert.throws(() => openDb(path), /older version/);
});

test('UK search results come before same-named places abroad', async () => {
  const fake = { ok: true, json: async () => ({ results: [
    { id: 1, name: 'Newport', country_code: 'US', country: 'United States', admin1: 'Rhode Island', latitude: 41.5, longitude: -71.3, timezone: 'America/New_York' },
    { id: 2, name: 'Newport', country_code: 'GB', country: 'United Kingdom', admin1: 'Wales', latitude: 51.6, longitude: -3, timezone: 'Europe/London' },
  ] }) };
  const results = await openMeteoGeocoder({ fetchImpl: async () => fake }).search('Newport');
  assert.deepEqual(results.map((r) => r.country), ['Wales', 'Rhode Island, United States']);
});

test('weather fetches retry dropped connections, and give up with a friendly error', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error('connect timeout');
    return { ok: true, status: 200 };
  };
  assert.equal((await fetchWithRetry('x', { fetchImpl: flaky, delayMs: 1 })).status, 200);
  assert.equal(calls, 3);

  const down = createGame({
    db: openDb(), provider: { daily: async () => { throw new Error('down'); } }, geocoder: mockGeocoder(),
  });
  await assert.rejects(down.view(null, LONDON), /Couldn't reach the weather service/);
});

test('a short rate limit (429) is retried; a bad request is not', async () => {
  const statuses = [429, 200];
  const res = await fetchWithRetry('x', { fetchImpl: async () => ({ ok: statuses[0] === 200, status: statuses.shift() }), delayMs: 1 });
  assert.equal(res.status, 200);
  let calls = 0;
  await fetchWithRetry('x', { fetchImpl: async () => (calls++, { ok: false, status: 400 }), delayMs: 1 });
  assert.equal(calls, 1);
});

test('Isle of Man, Jersey and Guernsey count as home in search, and "town, place" searches work', async () => {
  const douglases = [
    { id: 1, name: 'Douglas', country_code: 'US', country: 'United States', admin1: 'Georgia', latitude: 31.5, longitude: -82.8, timezone: 'America/New_York' },
    { id: 2, name: 'Douglas', country_code: 'IM', country: 'Isle of Man', admin1: 'Douglas', latitude: 54.15, longitude: -4.48, timezone: 'Europe/Isle_of_Man' },
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    const name = new URL(url).searchParams.get('name');
    calls.push(name);
    return { ok: true, json: async () => ({ results: name === 'Douglas' ? douglases : [] }) };
  };
  const geocoder = openMeteoGeocoder({ fetchImpl });
  const plain = await geocoder.search('Douglas');
  assert.deepEqual(plain.map((r) => r.country), ['Isle of Man', 'Georgia, United States']);
  const spaced = await geocoder.search('Douglas Isle of Man');
  assert.deepEqual(spaced.map((r) => r.id), ['gn:2']);
  const comma = await geocoder.search('Douglas, Georgia');
  assert.deepEqual(comma.map((r) => r.id), ['gn:1']);
  assert.deepEqual(calls, ['Douglas', 'Douglas Isle of Man', 'Douglas', 'Douglas, Georgia', 'Douglas']);
});
