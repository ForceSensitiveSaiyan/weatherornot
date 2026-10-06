import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createGame, GameError } from './game.js';
import { openMeteoProvider, mockProvider } from './weather.js';
import { openMeteoGeocoder, mockGeocoder } from './places.js';
import { synopObserver } from './observations.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TICK_MS = 10 * 60 * 1000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function createApp(game, { limiter = rateLimiter() } = {}) {
  // Routes get { user, body, query, ip, setToken }. Calling ensureUser() makes
  // a guest account on the spot, so nobody has to sign up before playing.
  const routes = {
    'GET /api/me': ({ user }) => ({ user, stats: user ? game.stats(user.id) : null }),
    'GET /api/places/popular': () => ({ places: game.popularPlaces() }),
    'GET /api/places/search': async ({ query, ip }) => {
      limiter(ip, 'search', 60);
      return { places: await game.searchPlaces(query.get('q')) };
    },
    'GET /api/game': async ({ user, query }) => game.view(user?.id, query.get('place')),
    'POST /api/picks': (ctx) => {
      const user = ensureUser(ctx);
      const round = game.makePick(user.id, Number(ctx.body.roundId), ctx.body.key, ctx.body.pick);
      return { round, user, stats: game.stats(user.id) };
    },
    'POST /api/banker': (ctx) => {
      const user = ensureUser(ctx);
      const key = ctx.body.key == null ? null : String(ctx.body.key);
      return { round: game.setBanker(user.id, Number(ctx.body.roundId), key) };
    },
    'POST /api/account': (ctx) => {
      limiter(ctx.ip, 'account', 20);
      game.saveAccount(ensureUser(ctx).id, ctx.body.name, ctx.body.password);
      return { ok: true };
    },
    'POST /api/login': (ctx) => {
      limiter(ctx.ip, 'login', 20);
      ctx.setToken(game.login(ctx.body.name, ctx.body.password));
      return { ok: true };
    },
    'POST /api/logout': (ctx) => {
      game.logout(ctx.token);
      ctx.setToken(null);
      return { ok: true };
    },
    'GET /api/leagues': ({ user }) => ({ leagues: user ? game.myLeagues(user.id) : [] }),
    'GET /api/leagues/preview': ({ query }) => ({ league: game.leaguePreview(query.get('code')) }),
    'POST /api/leagues': (ctx) => ({ league: game.createLeague(ensureUser(ctx).id, ctx.body.name) }),
    'POST /api/leagues/join': (ctx) => ({ league: game.joinLeague(ensureUser(ctx).id, ctx.body.code) }),
    'POST /api/leagues/leave': (ctx) => {
      game.leaveLeague(requireUser(ctx.user).id, Number(ctx.body.leagueId));
      return { ok: true };
    },
  };

  function ensureUser(ctx) {
    if (!ctx.user) {
      limiter(ctx.ip, 'guest', 30);
      ctx.setToken(game.createGuest());
    }
    return ctx.user;
  }

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      return url.pathname.startsWith('/api/') ? send(res, 404, { error: 'Not found' }) : serveStatic(url, req, res);
    }
    try {
      const token = parseCookies(req.headers.cookie).session;
      const ctx = {
        token,
        user: game.userForToken(token),
        body: req.method === 'POST' ? await readJson(req) : {},
        query: url.searchParams,
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
        setToken(newToken) {
          ctx.token = newToken;
          ctx.user = game.userForToken(newToken);
          res.setHeader('Set-Cookie', newToken
            ? `session=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`
            : 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        },
      };
      send(res, 200, await handler(ctx));
    } catch (err) {
      if (err instanceof GameError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong' });
    }
  };
}

function requireUser(user) {
  if (!user) throw new GameError('Play a game first', 401);
  return user;
}

// Fixed-window limit of `max` calls per hour per IP and action.
export function rateLimiter({ now = Date.now } = {}) {
  const windows = new Map();
  return (ip, action, max) => {
    const key = `${ip}:${action}`;
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start > 3_600_000) {
      w = { start: t, count: 0 };
      windows.set(key, w);
      if (windows.size > 50_000) windows.clear();
    }
    if (++w.count > max) throw new GameError('Too many attempts, try again later', 429);
  };
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

// The site's public address. Link previews (WhatsApp, Facebook, X) need
// absolute URLs, so set PUBLIC_URL in production; otherwise it's worked out
// from the request.
function siteOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] ?? 'http';
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
}

// Real files are served as-is; any other path without an extension (like an
// invite link, /join/ABC123) gets the app, which reads the URL itself.
async function serveStatic(url, req, res) {
  let rel = normalize(decodeURIComponent(url.pathname).slice(1));
  if (rel.startsWith('..')) return send(res, 404, { error: 'Not found' });
  if (!rel || !extname(rel)) rel = 'index.html';
  try {
    let data = await readFile(join(PUBLIC_DIR, rel));
    if (rel === 'index.html') data = data.toString().replaceAll('{{ORIGIN}}', siteOrigin(req));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
      ...(rel.startsWith('fonts/') && { 'Cache-Control': 'public, max-age=31536000, immutable' }),
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = process.env.WEATHER_PROVIDER === 'mock';
  const provider = mock ? mockProvider() : openMeteoProvider();
  const game = createGame({
    db: openDb(process.env.DB_PATH ?? 'weatherornot.db'),
    provider,
    geocoder: mock ? mockGeocoder() : openMeteoGeocoder(),
    // Settle on weather station reports unless running on fake weather.
    observer: mock || process.env.OBSERVATIONS === 'model' ? null : synopObserver(),
  });
  const tick = () => game.tick()
    .then((n) => n && console.log(`Settled ${n} game(s)`))
    .catch((err) => console.error('Tick failed:', err.message));
  tick();
  setInterval(tick, TICK_MS);
  const port = Number(process.env.PORT ?? 3000);
  createServer(createApp(game)).listen(port, () => {
    console.log(`WeatherOrNot running at http://localhost:${port} (weather: ${provider.name})`);
  });
}
