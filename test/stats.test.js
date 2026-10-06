import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createGame } from '../src/game.js';
import { createStats } from '../src/stats.js';
import { backupDaily } from '../src/backup.js';
import { createApp } from '../src/server.js';
import { mockProvider } from '../src/weather.js';
import { mockGeocoder } from '../src/places.js';

const LONDON = 'gn:2643743';
const day = { tmax: 15, tmin: 8, precip: 1, snow: 0, gust: 30, code: 3 };

test('stats: players by day, new players, who came back, and anonymous counts', async () => {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const weather = new Map(['2026-10-05', '2026-10-06', '2026-10-07'].map((d) => [d, day]));
  const db = openDb();
  const game = createGame({ db, provider: { daily: async () => weather }, geocoder: mockGeocoder(), now: () => clock.now });
  const stats = createStats(db, { now: () => clock.now });
  const player = () => game.userForToken(game.createGuest());
  const [ann, ben, cat] = [player(), player(), player()];

  // 5 Oct: Ann and Ben answer for 6 Oct's game.
  let { round } = await game.view(null, LONDON);
  game.makePick(ann.id, round.id, 'rain', 1);
  game.makePick(ben.id, round.id, 'rain', 0);
  stats.count('visit');
  stats.count('share-result');
  assert.equal(stats.count('something-made-up'), false);

  // 6 Oct: Ann comes back, Cat is new, Ben doesn't play.
  clock.now = new Date('2026-10-06T12:00:00Z');
  ({ round } = await game.view(null, LONDON));
  game.makePick(ann.id, round.id, 'temp', 1);
  game.makePick(cat.id, round.id, 'temp', 0);
  stats.count('visit');
  stats.count('visit');

  const { days, totals } = stats.summary(3);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-06', '2026-10-05', '2026-10-04']);
  assert.deepEqual(days[0], {
    date: '2026-10-06', players: 2, newPlayers: 1, cameBack: 1, playedDayBefore: 2,
    visits: 2, intros: 0, shares: 0, sharedOpens: 0,
  });
  assert.deepEqual([days[1].players, days[1].newPlayers, days[1].visits, days[1].shares], [2, 2, 1, 1]);
  assert.equal(totals.players, 3);
});

test('backups: one copy a day, readable, oldest removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'won-backup-'));
  try {
    const db = openDb(join(dir, 'live.db'));
    db.exec("INSERT INTO users (name) VALUES ('Ann')");
    const backups = join(dir, 'backups');
    const made = backupDaily(db, backups, '2026-10-06', 2);
    assert.ok(made.endsWith('weatherornot-2026-10-06.db'));
    assert.equal(backupDaily(db, backups, '2026-10-06', 2), null, 'only once a day');
    backupDaily(db, backups, '2026-10-07', 2);
    backupDaily(db, backups, '2026-10-08', 2);
    assert.deepEqual(readdirSync(backups).sort(), ['weatherornot-2026-10-07.db', 'weatherornot-2026-10-08.db']);
    const copy = new DatabaseSync(join(backups, 'weatherornot-2026-10-08.db'));
    assert.equal(copy.prepare('SELECT name FROM users').get().name, 'Ann');
    copy.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health check, anonymous hits, and stats behind the admin token', async (t) => {
  const db = openDb();
  const game = createGame({ db, provider: mockProvider(), geocoder: mockGeocoder() });
  const stats = createStats(db);
  const server = createServer(createApp(game, { stats })).listen(0);
  t.after(() => { server.close(); delete process.env.ADMIN_TOKEN; });
  const base = `http://localhost:${server.address().port}`;

  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  // sendBeacon posts as text/plain; it still counts, and never sets a cookie.
  const hit = await fetch(`${base}/api/hit`, { method: 'POST', body: JSON.stringify({ name: 'visit' }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('set-cookie'), null);
  await fetch(`${base}/api/hit`, { method: 'POST', body: JSON.stringify({ name: 'nonsense' }) });

  assert.equal((await fetch(`${base}/api/admin/stats`)).status, 404);
  process.env.ADMIN_TOKEN = 'correct-horse-battery';
  const summary = await (await fetch(`${base}/api/admin/stats`, { headers: { 'x-admin-token': 'correct-horse-battery' } })).json();
  assert.equal(summary.days[0].visits, 1);
  assert.equal(summary.days.length, 14);
});
