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

async function startServer(t, env = {}) {
  Object.assign(process.env, env);
  const game = createGame({ db: openDb(), provider: mockProvider(), geocoder: mockGeocoder() });
  const server = createServer(createApp(game)).listen(0);
  t.after(() => { server.close(); for (const k of Object.keys(env)) delete process.env[k]; });
  return { game, base: `http://localhost:${server.address().port}`, port: server.address().port };
}

test('malformed addresses get a 400 and never crash the server', async (t) => {
  const { base, port } = await startServer(t);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  // A raw request line that isn't a valid URL.
  const { connect } = await import('node:net');
  const reply = await new Promise((resolve) => {
    const sock = connect(port, 'localhost', () => sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    let data = '';
    sock.on('data', (d) => { data += d; sock.end(); });
    sock.on('close', () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`${base}/api/me`)).status, 200, 'still up');
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/join/ABC123/`)).status, 200);
});

test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async (t) => {
  const { base } = await startServer(t);
  const login = (ip) => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ name: 'nobody', password: 'wrongpass' }),
  });
  for (let i = 0; i < 20; i++) assert.equal((await login(`10.0.0.${i}`)).status, 401);
  assert.equal((await login('10.0.0.99')).status, 429, 'a fake header does not reset the limit');
});

test('with TRUST_PROXY=1, only the address our proxy added counts', async (t) => {
  const { base } = await startServer(t, { TRUST_PROXY: '1' });
  const login = (xff) => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify({ name: 'nobody', password: 'wrongpass' }),
  });
  // A client can prepend anything; the proxy appends the real address last.
  for (let i = 0; i < 20; i++) await login(`6.6.6.${i}, 203.0.113.7`);
  assert.equal((await login('1.2.3.4, 203.0.113.7')).status, 429);
  assert.equal((await login('203.0.113.8')).status, 401, 'a different real client is unaffected');
});

test('junk requests get a 400, not a 500, and never create guest accounts', async (t) => {
  const { base, game } = await startServer(t);
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const view = await (await fetch(`${base}/api/game?place=gn:2643743`)).json();
  const cases = [
    ['/api/picks', 'null'], ['/api/picks', '[]'], ['/api/picks', '"x"'],
    ['/api/picks', JSON.stringify({ roundId: view.round.id, pick: 1 })],
    ['/api/picks', JSON.stringify({ roundId: view.round.id, key: { a: 1 }, pick: 1 })],
    ['/api/picks', JSON.stringify({ roundId: 99999, key: 'rain', pick: 1 })],
    ['/api/banker', JSON.stringify({ roundId: view.round.id, key: 7 })],
    ['/api/leagues', JSON.stringify({ name: { a: 1 } })],
    ['/api/leagues', JSON.stringify({ name: '   ' })],
    ['/api/leagues/join', JSON.stringify({ code: 'NOPE00' })],
    ['/api/account', JSON.stringify({ name: 'x', password: 'y' })],
  ];
  for (const [path, body] of cases) {
    const res = await post(path, body);
    assert.ok(res.status >= 400 && res.status < 500, `${path} ${body} -> ${res.status}`);
    assert.equal(res.headers.get('set-cookie'), null, `${path} ${body} made a guest`);
  }
  assert.equal((await post('/api/logout', '{}')).status, 200, 'logout without a cookie');
  assert.equal(game.listReports().length, 0);
});

test('shared links can look up a place by id', async (t) => {
  const { base } = await startServer(t);
  const { place } = await (await fetch(`${base}/api/places/info?id=gn:3042237`)).json();
  assert.equal(place.name, 'Douglas');
  assert.equal((await fetch(`${base}/api/places/info?id=gn:1`)).status, 404);
});

test('names, short share links and link previews that say who sent them', async (t) => {
  const game = createGame({ db: openDb(), provider: mockProvider(), geocoder: mockGeocoder() });
  const server = createServer(createApp(game)).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const post = (path, body, cookie) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(body),
  });

  assert.equal((await post('/api/name', { name: 'Sam' })).status, 401, 'play first');
  const { round } = await (await fetch(`${base}/api/game?place=gn:2643743`)).json();
  const pick = await post('/api/picks', { roundId: round.id, key: 'rain', pick: 1 });
  const cookie = pick.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/name', { name: '<b>' }, cookie)).status, 400);
  assert.deepEqual(await (await post('/api/name', { name: 'Sam' }, cookie)).json(), { name: 'Sam' });

  const { code } = await (await post('/api/shares', { roundId: round.id }, cookie)).json();
  const page = await (await fetch(`${base}/r/${code}`)).text();
  assert.match(page, /<meta property="og:title" content="Sam has answered tomorrow&#39;s weather questions for London">/);
  assert.match(page, new RegExp(`<meta property="og:url" content="${base}/r/${code}">`));
  const { share } = await (await fetch(`${base}/api/shares/view?code=${code}`)).json();
  assert.equal(share.name, 'Sam');

  // Unknown codes still get the app, with the ordinary preview.
  const unknown = await fetch(`${base}/r/ZZZZZZ`);
  assert.equal(unknown.status, 200);
  assert.match(await unknown.text(), /<meta property="og:title" content="WeatherOrNot">/);

  const { league } = await (await post('/api/leagues', { name: 'Quayside' }, cookie)).json();
  assert.match(await (await fetch(`${base}/join/${league.code}`)).text(), /og:title" content="Sam invited you to Quayside"/);
});
