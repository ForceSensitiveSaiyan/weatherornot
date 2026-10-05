import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createGame, STARTING_POINTS } from '../src/game.js';

const LONDON = [{ id: 'london', name: 'London', lat: 0, lon: 0, tz: 'Europe/London' }];

function setup() {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const weather = new Map([['2026-10-06', { tmax: 17.8, precip: 3.2 }]]);
  const provider = { name: 'fake', daily: async () => weather };
  const game = createGame({ db: openDb(), provider, now: () => clock.now, cities: LONDON });
  return { game, clock, weather };
}

test('full day: markets open, bets placed, betting closes, markets settle', async () => {
  const { game, clock, weather } = setup();
  await game.openMarkets();
  const markets = game.listMarkets();
  assert.equal(markets.length, 2);
  const temp = markets.find((m) => m.kind === 'temp_over');
  const rain = markets.find((m) => m.kind === 'rain');
  assert.equal(temp.line, 18.5);
  assert.equal(temp.date, '2026-10-06');

  const alice = game.userForToken(game.register('alice', 'secret1'));
  const bob = game.userForToken(game.register('bob', 'secret2'));
  game.placeBet(alice.id, temp.id, 1, 100);
  game.placeBet(bob.id, temp.id, 0, 300);
  game.placeBet(alice.id, rain.id, 1, 50);
  assert.equal(game.userForToken(game.login('alice', 'secret1')).points, STARTING_POINTS - 150);

  // Midnight in London: betting closes but nothing settles until the day ends.
  clock.now = new Date('2026-10-05T23:30:00Z');
  assert.throws(() => game.placeBet(bob.id, temp.id, 1, 10), /closed/);
  assert.equal(await game.settleMarkets(), 0);

  // Next morning the observed weather comes in: warmer than forecast, and dry.
  clock.now = new Date('2026-10-07T08:00:00Z');
  weather.set('2026-10-06', { tmax: 19.4, precip: 0.4 });
  assert.equal(await game.settleMarkets(), 2);

  const points = Object.fromEntries(game.leaderboard().map((u) => [u.name, u.points]));
  // Alice wins the 400 pot on temp; on rain (0.4mm < 1mm) nobody backed NO, so she gets 50 back.
  assert.equal(points.alice, STARTING_POINTS - 150 + 400 + 50);
  assert.equal(points.bob, STARTING_POINTS - 300);

  // Settling again is a no-op.
  assert.equal(await game.settleMarkets(), 0);
});

test('cannot bet more points than you have', async () => {
  const { game } = setup();
  await game.openMarkets();
  const [m] = game.listMarkets();
  const u = game.userForToken(game.register('carol', 'secret3'));
  assert.throws(() => game.placeBet(u.id, m.id, 1, STARTING_POINTS + 1), /Not enough points/);
  assert.throws(() => game.placeBet(u.id, m.id, 1, 1.5), /whole number/);
});

test('accounts: duplicate names and wrong passwords are rejected', () => {
  const { game } = setup();
  game.register('dave', 'secret4');
  assert.throws(() => game.register('DAVE', 'whatever'), /taken/);
  assert.throws(() => game.login('dave', 'wrongpw'), /Wrong name or password/);
  assert.throws(() => game.register('x', 'secret5'), /Name must be/);
});
