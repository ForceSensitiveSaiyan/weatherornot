import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createGame, STARTING_POINTS, TOPUP_POINTS } from '../src/game.js';
import { marketsFor, resolve } from '../src/markets.js';

const CITY = [{ id: 'london', name: 'London', lat: 0, lon: 0, tz: 'Europe/London' }];

function setup(forecast = { tmax: 17.8, tmin: 9, precip: 3.2, snow: 0, gust: 41 }) {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const weather = new Map([['2026-10-06', forecast]]);
  const game = createGame({
    db: openDb(), provider: { daily: async () => weather }, now: () => clock.now, cities: CITY,
  });
  return { game, clock, weather };
}

test('snow is only offered when it is plausible', () => {
  const mild = marketsFor({ tmax: 18, tmin: 9, precip: 0, snow: 0, gust: 20 }).map((m) => m.kind);
  assert.deepEqual(mild, ['temp_over', 'rain', 'wind']);
  const cold = marketsFor({ tmax: 3, tmin: -2, precip: 2, snow: 1.4, gust: 20 }).map((m) => m.kind);
  assert.deepEqual(cold, ['temp_over', 'rain', 'snow', 'wind']);
});

test('wind line sits near the forecast and cannot tie', () => {
  const [wind] = marketsFor({ gust: 41 }).filter((m) => m.kind === 'wind');
  assert.equal(wind.line, 42.5);
  assert.deepEqual(resolve({ kind: 'wind', line: 42.5 }, { gust: 50 }), { value: 50, outcome: 1 });
  assert.equal(resolve({ kind: 'wind', line: 42.5 }, { gust: null }), null);
});

test('wind and snow markets settle like any other', async () => {
  const { game, clock, weather } = setup({ tmax: 1, tmin: -3, precip: 4, snow: 2, gust: 30 });
  await game.openMarkets();
  const byKind = Object.fromEntries(game.listMarkets().map((m) => [m.kind, m]));
  assert.equal(byKind.snow.unit, 'cm');
  const u = game.userForToken(game.register('frosty', 'secret1'));
  game.placeBet(u.id, byKind.snow.id, 1, 100);
  game.placeBet(u.id, byKind.wind.id, 0, 100);
  clock.now = new Date('2026-10-07T08:00:00Z');
  weather.set('2026-10-06', { tmax: 0.5, tmin: -4, precip: 3, snow: 2.5, gust: 28 });
  assert.equal(await game.settleMarkets(), 4);
  // Only one player, so both bets just come back: the pot is entirely theirs.
  assert.equal(game.userForToken(game.login('frosty', 'secret1')).points, STARTING_POINTS);
  const history = game.myBets(u.id);
  assert.ok(history.every((b) => b.market.status === 'settled' && b.payout === 100));
});

test('broke players can top up once a day', async () => {
  const { game, clock } = setup();
  await game.openMarkets();
  const [m] = game.listMarkets();
  const token = game.register('broke', 'secret1');
  const u = game.userForToken(token);
  assert.equal(u.canTopUp, false);
  assert.throws(() => game.topUp(u.id), /once a day/);

  game.placeBet(u.id, m.id, 1, STARTING_POINTS - 10);
  assert.equal(game.userForToken(token).canTopUp, true);
  assert.equal(game.topUp(u.id).points, TOPUP_POINTS);
  assert.equal(game.userForToken(token).canTopUp, false);

  game.placeBet(u.id, m.id, 1, TOPUP_POINTS);
  assert.throws(() => game.topUp(u.id), /once a day/);
  clock.now = new Date('2026-10-06T00:30:00Z');
  assert.equal(game.topUp(u.id).points, TOPUP_POINTS);
});

test('leagues: create, share code, join, standings, leave', () => {
  const { game } = setup();
  const ann = game.userForToken(game.register('ann', 'secret1'));
  const ben = game.userForToken(game.register('ben', 'secret2'));
  game.register('outsider', 'secret3');

  const league = game.createLeague(ann.id, '  Office Forecasters ');
  assert.equal(league.name, 'Office Forecasters');
  assert.match(league.code, /^[A-Z2-9]{6}$/);
  assert.throws(() => game.joinLeague(ben.id, 'NOPE00'), /No league/);
  game.joinLeague(ben.id, league.code.toLowerCase());
  game.joinLeague(ben.id, league.code); // joining twice is harmless

  const [mine] = game.myLeagues(ann.id);
  assert.equal(mine.isOwner, true);
  assert.deepEqual(mine.standings.map((s) => s.name), ['ann', 'ben']);
  assert.equal(game.myLeagues(ben.id)[0].isOwner, false);

  game.leaveLeague(ben.id, league.id);
  assert.deepEqual(game.myLeagues(ben.id), []);
  assert.throws(() => game.leaveLeague(ben.id, league.id), /not in that league/);
  assert.throws(() => game.createLeague(ann.id, '   '), /1–40/);
});
