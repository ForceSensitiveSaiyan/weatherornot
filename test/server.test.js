import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createGame } from '../src/game.js';
import { createApp, rateLimiter } from '../src/server.js';
import { mockProvider } from '../src/weather.js';
import { mockGeocoder } from '../src/places.js';

test('first pick creates a guest session; invite links serve the app', async (t) => {
  const game = createGame({ db: openDb(), provider: mockProvider(), geocoder: mockGeocoder() });
  const server = createServer(createApp(game)).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const view = await (await fetch(`${base}/api/game?place=gn:2643743`)).json();
  assert.equal(view.round.questions.length, 3);

  const res = await fetch(`${base}/api/picks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roundId: view.round.id, key: 'rain', pick: 1 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.guest, true);
  assert.equal(body.round.questions[0].myPick, 1);
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.user.id, body.user.id);

  const page = await fetch(`${base}/join/ABC123`);
  assert.match(page.headers.get('content-type'), /text\/html/);
  // Link previews need absolute image URLs.
  assert.match(await page.text(), new RegExp(`<meta property="og:image" content="${base}/og.png">`));
  assert.equal((await fetch(`${base}/missing.png`)).status, 404);
});

test('rate limiter blocks after the limit and resets after an hour', () => {
  let t = 0;
  const limit = rateLimiter({ now: () => t });
  limit('1.2.3.4', 'login', 2);
  limit('1.2.3.4', 'login', 2);
  assert.throws(() => limit('1.2.3.4', 'login', 2), /Too many/);
  limit('5.6.7.8', 'login', 2);
  t = 3_600_001;
  limit('1.2.3.4', 'login', 2);
});

test('admin endpoints need the admin token, and are off without one', async (t) => {
  const game = createGame({ db: openDb(), provider: mockProvider(), geocoder: mockGeocoder() });
  const server = createServer(createApp(game)).listen(0);
  t.after(() => { server.close(); delete process.env.ADMIN_TOKEN; });
  const base = `http://localhost:${server.address().port}`;
  const get = (token) => fetch(`${base}/api/admin/reports`, { headers: token ? { 'x-admin-token': token } : {} });
  assert.equal((await get('anything')).status, 404, 'off when ADMIN_TOKEN is unset');
  process.env.ADMIN_TOKEN = 'correct-horse-battery';
  assert.equal((await get('wrong-horse-battery!')).status, 404);
  assert.equal((await get()).status, 404);
  const ok = await get('correct-horse-battery');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { reports: [] });
});
