import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createGame, GameError } from './game.js';
import { openMeteoProvider, mockProvider } from './weather.js';
import { openMeteoGeocoder, mockGeocoder } from './places.js';
import { synopObserver } from './observations.js';
import { createStats } from './stats.js';
import { backupDaily } from './backup.js';
import { localDate } from './time.js';
import { weatherLine, sourceName, shortDay } from '../public/words.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TICK_MS = 10 * 60 * 1000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function createApp(game, { limiter = rateLimiter(), stats = null } = {}) {
  // Routes get { user, body, query, ip, setToken }. Calling ensureUser() makes
  // a guest account on the spot, so nobody has to sign up before playing.
  const routes = {
    // For the host's health checks.
    'GET /healthz': () => (stats?.ping(), { ok: true }),
    'GET /api/me': ({ user }) => ({ user, stats: user ? game.stats(user.id) : null }),
    'GET /api/places/popular': () => ({ places: game.popularPlaces() }),
    'GET /api/places/search': async ({ query, ip }) => {
      limiter(ip, 'search', 60);
      return { places: await game.searchPlaces(query.get('q')) };
    },
    'GET /api/game': async ({ user, query }) => game.view(user?.id, query.get('place')),
    'GET /api/places/info': ({ query }) => ({ place: game.placeInfo(query.get('id')) }),
    'POST /api/picks': (ctx) => {
      const { roundId, key, pick } = ctx.body;
      game.checkPick(Number(roundId), key, pick); // before making a guest, so junk requests don't create accounts
      const user = ensureUser(ctx);
      const round = game.makePick(user.id, Number(roundId), key, pick);
      return { round, user, stats: game.stats(user.id) };
    },
    'POST /api/banker': (ctx) => {
      const key = ctx.body.key ?? null;
      game.checkBanker(Number(ctx.body.roundId), key);
      const user = ensureUser(ctx);
      return { round: game.setBanker(user.id, Number(ctx.body.roundId), key) };
    },
    'POST /api/reports': (ctx) => {
      limiter(ctx.ip, 'report', 20);
      const key = ctx.body.key == null || ctx.body.key === '' ? null : ctx.body.key;
      game.reportProblem(requireUser(ctx.user).id, Number(ctx.body.roundId), key, ctx.body.message);
      return { ok: true };
    },
    // Admin: needs ADMIN_TOKEN set on the server and sent as x-admin-token.
    'GET /api/admin/reports': (ctx) => (requireAdmin(ctx), { reports: game.listReports() }),
    'POST /api/admin/void': (ctx) => {
      requireAdmin(ctx);
      game.voidQuestion(Number(ctx.body.roundId), ctx.body.key, ctx.body.reason);
      return { ok: true };
    },
    'GET /api/admin/stats': (ctx) => (requireAdmin(ctx), stats ? stats.summary() : { days: [], totals: {} }),
    // Anonymous daily counts (visits, shares). No user, cookie or address is kept.
    'POST /api/hit': (ctx) => {
      limiter(ctx.ip, 'hit', 300);
      stats?.count(String(ctx.body.name ?? ''));
      return { ok: true };
    },
    'POST /api/admin/dismiss': (ctx) => {
      requireAdmin(ctx);
      game.dismissReport(Number(ctx.body.reportId));
      return { ok: true };
    },
    'POST /api/name': (ctx) => {
      limiter(ctx.ip, 'name', 30);
      return { name: game.setName(requireUser(ctx.user).id, ctx.body.name) };
    },
    'POST /api/shares': (ctx) => {
      limiter(ctx.ip, 'share', 60);
      return { code: game.createShare(requireUser(ctx.user).id, Number(ctx.body.roundId)) };
    },
    'GET /api/shares/view': ({ query }) => ({ share: game.shareView(query.get('code')) }),
    'POST /api/account': (ctx) => {
      limiter(ctx.ip, 'account', 20);
      game.validateCredentials(ctx.body.name, ctx.body.password);
      game.saveAccount(ensureUser(ctx).id, ctx.body.name, ctx.body.password);
      return { ok: true };
    },
    'POST /api/login': (ctx) => {
      limiter(ctx.ip, 'login', 20);
      const guest = ctx.user?.guest ? ctx.user : null;
      ctx.setToken(game.login(ctx.body.name, ctx.body.password));
      // Answers made as a guest on this device carry over to the account.
      let moved = 0;
      try {
        if (guest) moved = game.mergeGuest(guest.id, ctx.user.id);
      } catch (err) {
        console.error('Merging guest answers failed:', err.message);
      }
      return { ok: true, moved };
    },
    'POST /api/logout': (ctx) => {
      if (ctx.token) game.logout(ctx.token);
      ctx.setToken(null);
      return { ok: true };
    },
    'GET /api/leagues': ({ user }) => ({ leagues: user ? game.myLeagues(user.id) : [] }),
    'GET /api/leagues/preview': ({ query }) => ({ league: game.leaguePreview(query.get('code')) }),
    'POST /api/leagues': (ctx) => {
      game.checkLeagueName(ctx.body.name);
      return { league: game.createLeague(ensureUser(ctx).id, ctx.body.name) };
    },
    'POST /api/leagues/join': (ctx) => {
      game.leaguePreview(ctx.body.code); // throws for a bad code before making a guest
      return { league: game.joinLeague(ensureUser(ctx).id, ctx.body.code) };
    },
    'POST /api/leagues/leave': (ctx) => {
      game.leaveLeague(requireUser(ctx.user).id, Number(ctx.body.leagueId));
      return { ok: true };
    },
  };

  // Constant-time check of the admin token; without ADMIN_TOKEN set, admin is off.
  function requireAdmin(ctx) {
    const expected = process.env.ADMIN_TOKEN;
    const given = String(ctx.adminToken ?? '');
    if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      limiter(ctx.ip, 'admin', 20);
      throw new GameError('Not found', 404);
    }
  }

  function ensureUser(ctx) {
    if (!ctx.user) {
      limiter(ctx.ip, 'guest', 30);
      ctx.setToken(game.createGuest());
    }
    return ctx.user;
  }

  // Link previews (WhatsApp, iMessage) for share and invite links say who
  // sent them, instead of the generic card.
  function previewFor(path) {
    try {
      const shared = path.match(/^\/r\/([A-Za-z0-9]{6})\/?$/)?.[1];
      if (shared) {
        const s = game.shareView(shared);
        if (!s.settled) {
          return { title: `${s.name} has answered tomorrow's weather questions for ${s.place.name}`, description: 'Three yes or no questions. Your go. Free, no signup.' };
        }
        return {
          title: `${s.name} got ${s.got} of ${s.of} in ${s.place.name}`,
          description: `${shortDay(s.date)}${s.source?.type === 'station' ? ` at ${sourceName(s.source)}` : ''}: ${weatherLine(s.questions)}. Tomorrow's three questions are open.`,
        };
      }
      const invite = path.match(/^\/join\/([A-Za-z0-9]{6})\/?$/)?.[1];
      if (invite) {
        const l = game.leaguePreview(invite);
        return {
          title: `${l.owner ? `${l.owner} invited you to ` : ''}${l.name}`,
          description: `${l.members} ${l.members === 1 ? 'player' : 'players'} guessing tomorrow's weather. Three questions a day, free, no signup.`,
        };
      }
    } catch { /* unknown code: the generic card */ }
    return null;
  }

  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      return serveStatic(url, req, res, previewFor).catch((err) => {
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'Something went wrong' });
      });
    }
    try {
      const token = parseCookies(req.headers.cookie).session;
      const ctx = {
        token,
        user: game.userForToken(token),
        body: req.method === 'POST' ? await readJson(req) : {},
        query: url.searchParams,
        ip: clientIp(req),
        adminToken: req.headers['x-admin-token'],
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
  if (!user) throw new GameError('Answer a question first so we know who you are.', 401);
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

// The visitor's address. X-Forwarded-For is easy to fake, so it's only used
// when TRUST_PROXY says how many proxies we run behind (e.g. 1 behind a
// single load balancer), and then only the entry our own proxy added.
function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  if (hops > 0 && req.headers['x-forwarded-for']) {
    const chain = req.headers['x-forwarded-for'].split(',').map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new GameError('Something went wrong. Refresh and try again.', 413);
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new GameError('Something went wrong. Refresh and try again.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GameError('Something went wrong. Refresh and try again.');
  }
  return body;
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
// The app's own pages; any other path without a file extension is a 404.
const APP_PATHS = /^\/((join|r)\/[^/]*\/?)?$/;

const DEFAULT_PREVIEW = {
  title: 'WeatherOrNot',
  description: 'Reckon you can beat the forecast? Three questions on tomorrow\'s weather where you live. Free, no signup.',
};
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function serveStatic(url, req, res, previewFor = () => null) {
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }
  let rel = normalize(path.slice(1));
  if (rel.startsWith('..') || rel.includes('\0')) return send(res, 404, { error: 'Not found' });
  if (!extname(rel)) {
    if (!APP_PATHS.test(path)) return notFound(res);
    rel = 'index.html';
  }
  try {
    let data = await readFile(join(PUBLIC_DIR, rel));
    if (rel === 'index.html') {
      const preview = previewFor(path) ?? DEFAULT_PREVIEW;
      data = data.toString().replaceAll('{{ORIGIN}}', siteOrigin(req))
        .replaceAll('{{OG_TITLE}}', escAttr(preview.title)).replaceAll('{{OG_DESC}}', escAttr(preview.description))
        .replaceAll('{{OG_PATH}}', escAttr(url.pathname));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
      ...(rel.startsWith('fonts/') && { 'Cache-Control': 'public, max-age=31536000, immutable' }),
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · WeatherOrNot</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="app doc"><header class="top"><a class="logo" href="/" style="text-decoration:none;color:inherit">Weather<span>Or</span>Not</a></header>
<main><article class="card"><h1>Nothing here</h1><p>That page has blown away. <a href="/">Back to the game</a>.</p></article></main></div></body></html>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = process.env.WEATHER_PROVIDER === 'mock';
  const provider = mock ? mockProvider() : openMeteoProvider();
  const dbPath = process.env.DB_PATH ?? 'weatherornot.db';
  const db = openDb(dbPath);
  const stats = createStats(db);
  const game = createGame({
    db,
    provider,
    geocoder: mock ? mockGeocoder() : openMeteoGeocoder(),
    // Settle on weather station reports unless running on fake weather.
    observer: mock || process.env.OBSERVATIONS === 'model' ? null : synopObserver(),
  });
  // A copy of the database once a day, kept for BACKUP_KEEP days.
  const backupDir = process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups');
  const backup = () => {
    if (dbPath === ':memory:' || backupDir === 'off') return;
    try {
      const file = backupDaily(db, backupDir, localDate('Europe/London'), Number(process.env.BACKUP_KEEP ?? 14));
      if (file) console.log(`Backed up to ${file}`);
    } catch (err) {
      console.error('Backup failed:', err.message);
    }
  };
  const tick = () => {
    backup();
    return game.tick()
      .then((n) => n && console.log(`Settled ${n} game(s)`))
      .catch((err) => console.error('Tick failed:', err.message));
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer(createApp(game, { stats })).listen(port, () => {
    console.log(`WeatherOrNot running at http://localhost:${port} (weather: ${provider.name})`);
  });
  // Hosts send SIGTERM before a restart or deploy: finish requests, close the database cleanly.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      clearInterval(timer);
      server.close(() => {
        db.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
