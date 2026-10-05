import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createGame, POINTS } from '../src/game.js';
import { questionsFor, resolveQuestion } from '../src/questions.js';
import { mockGeocoder } from '../src/places.js';

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

test('wildcard question follows the forecast', () => {
  const keys = (t) => questionsFor(t, mild).map((x) => x.key);
  assert.deepEqual(keys(mild), ['rain', 'warmer', 'wind']);
  assert.deepEqual(keys({ ...mild, tmax: 29 }), ['rain', 'warmer', 'heat']);
  assert.deepEqual(keys({ ...mild, tmax: 2, tmin: -1, snow: 1 }), ['rain', 'warmer', 'snow']);
  const heat = questionsFor({ ...mild, tmax: 29 }, mild).find((x) => x.key === 'heat');
  assert.equal(heat.line, 30);
  assert.equal(heat.forecastSays, 0);
});

test("'warmer' is judged against today's actual high, not the forecast", () => {
  const [, warmer] = questionsFor({ ...mild, tmax: 18 }, { ...mild, tmax: 16 });
  assert.equal(warmer.forecastSays, 1);
  const weather = new Map([['2026-10-05', { tmax: 19 }], ['2026-10-06', { tmax: 18 }]]);
  assert.deepEqual(resolveQuestion(warmer, weather, '2026-10-06'), { answer: 0, observed: 18, line: 19 });
  assert.equal(resolveQuestion(warmer, new Map([['2026-10-06', { tmax: 18 }]]), '2026-10-06'), null);
});

test('a full day: pick, lock at local midnight, settle, score with bonuses', async () => {
  const { game, clock, weather, player } = setup();
  const view = await game.view(null, LONDON);
  assert.equal(view.round.date, '2026-10-06');
  assert.equal(view.round.number, 6);
  assert.equal(view.round.closesAt, '2026-10-05T23:00:00.000Z');
  // Forecast: 3.2 mm rain (yes), warmer 17.8 vs 16 (yes), gusts 41 vs line 40 (yes).
  const [rain, warmer, wind] = view.round.questions;
  assert.deepEqual([rain.forecastSays, warmer.forecastSays, wind.key, wind.line], [1, 1, 'wind', 40]);

  const ann = player();
  const ben = player();
  const cat = player();
  const id = view.round.id;
  for (const p of [ann, ben, cat]) game.makePick(p.id, id, 'rain', 1);
  game.makePick(ann.id, id, 'warmer', 0); // against the forecast, and alone
  game.makePick(ben.id, id, 'warmer', 1);
  game.makePick(cat.id, id, 'warmer', 1);
  game.makePick(ann.id, id, 'wind', 1);
  game.makePick(ann.id, id, 'wind', 0); // changing your mind is fine
  assert.throws(() => game.makePick(ann.id, id, 'snow', 1), /No such question/);

  clock.now = new Date('2026-10-05T23:30:00Z'); // past midnight in London
  assert.throws(() => game.makePick(ben.id, id, 'wind', 1), /locked/);
  assert.equal(await game.settleRounds(), 0);

  clock.now = new Date('2026-10-07T07:00:00Z');
  weather.set('2026-10-06', { ...mild, tmax: 15.5, precip: 6, gust: 35 }); // wet, cooler, calmer
  weather.set('2026-10-07', mild);
  weather.set('2026-10-08', mild);
  assert.equal(await game.settleRounds(), 1);
  assert.equal(await game.settleRounds(), 0);

  const annView = await game.view(ann.id, LONDON);
  const last = annView.lastRound;
  assert.equal(last.questions[1].result.answer, 0);
  // Ann: rain right (10), warmer right + beat forecast + minority (25), wind right + beat forecast (20)
  assert.deepEqual(last.score, { correct: 3, points: 10 + 25 + 20 });
  assert.deepEqual(last.questions[1].score.bonuses, ['beatForecast', 'minority']);
  assert.equal(annView.stats.points, 55);
  assert.equal((await game.view(ben.id, LONDON)).lastRound.score.points, POINTS.correct);
  assert.deepEqual(annView.leaderboard.map((r) => r.points), [55, 10, 10]);
  // A fresh game for the 8th has opened.
  assert.equal(annView.round.date, '2026-10-08');
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
  const [cape] = await game.searchPlaces('cape');
  assert.equal(cape.name, 'Cape Town');
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
