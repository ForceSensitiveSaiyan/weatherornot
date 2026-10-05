import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createGame, GameError } from './game.js';
import { openMeteoProvider, mockProvider } from './weather.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TICK_MS = 10 * 60 * 1000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function createApp(game) {
  const routes = {
    'POST /api/register': ({ body }) => ({ token: game.register(body.name, body.password) }),
    'POST /api/login': ({ body }) => ({ token: game.login(body.name, body.password) }),
    'POST /api/logout': ({ token }) => (game.logout(token), { token: null }),
    'GET /api/me': ({ user }) => ({ user }),
    'GET /api/markets': ({ user }) => ({ markets: game.listMarkets(user?.id) }),
    'GET /api/leaderboard': () => ({ leaderboard: game.leaderboard() }),
    'GET /api/my-bets': ({ user }) => ({ bets: game.myBets(requireUser(user).id) }),
    'POST /api/bets': ({ user, body }) => ({
      user: game.placeBet(requireUser(user).id, Number(body.marketId), body.side, body.amount),
    }),
    'POST /api/topup': ({ user }) => ({ user: game.topUp(requireUser(user).id) }),
    'GET /api/leagues': ({ user }) => ({ leagues: game.myLeagues(requireUser(user).id) }),
    'POST /api/leagues': ({ user, body }) => ({ league: game.createLeague(requireUser(user).id, body.name) }),
    'POST /api/leagues/join': ({ user, body }) => ({ league: game.joinLeague(requireUser(user).id, body.code) }),
    'POST /api/leagues/leave': ({ user, body }) => (
      game.leaveLeague(requireUser(user).id, Number(body.leagueId)), { ok: true }),
  };

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return url.pathname.startsWith('/api/') ? send(res, 404, { error: 'Not found' }) : serveStatic(url, res);
    try {
      const token = parseCookies(req.headers.cookie).session;
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await handler({ user: game.userForToken(token), token, body });
      if (result && 'token' in result) {
        res.setHeader('Set-Cookie', result.token
          ? `session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
          : 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        return send(res, 200, { ok: true });
      }
      send(res, 200, result);
    } catch (err) {
      if (err instanceof GameError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong' });
    }
  };
}

function requireUser(user) {
  if (!user) throw new GameError('Log in first', 401);
  return user;
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new GameError('Request too large', 413);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new GameError('Invalid JSON');
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k));
}

async function serveStatic(url, res) {
  const rel = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (rel.startsWith('..')) return send(res, 404, { error: 'Not found' });
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.WEATHER_PROVIDER === 'mock' ? mockProvider() : openMeteoProvider();
  const game = createGame({ db: openDb(process.env.DB_PATH ?? 'weatherornot.db'), provider });
  const tick = () => game.tick()
    .then((n) => n && console.log(`Settled ${n} market(s)`))
    .catch((err) => console.error('Tick failed:', err.message));
  tick();
  setInterval(tick, TICK_MS);
  const port = Number(process.env.PORT ?? 3000);
  createServer(createApp(game)).listen(port, () => {
    console.log(`WeatherOrNot running at http://localhost:${port} (weather: ${provider.name})`);
  });
}
