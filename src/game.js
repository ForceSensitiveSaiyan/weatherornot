import { randomInt } from 'node:crypto';
import { CITIES, cityById } from './cities.js';
import { transaction } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { settlePool } from './pool.js';
import { localDate, addDays } from './time.js';
import { MARKET_KINDS, marketsFor, resolve } from './markets.js';

export const STARTING_POINTS = 1000;
// Players below this can top back up to it once per (UTC) day, so going broke isn't game over.
export const TOPUP_POINTS = 100;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I lookalikes

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Game rules: markets for each city's *tomorrow* open automatically, betting
// closes when that day starts locally, and settlement runs once the day is over.
export function createGame({ db, provider, now = () => new Date(), cities = CITIES }) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
    userById: db.prepare('SELECT id, name, points, last_topup FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (name, pass_hash, salt, points) VALUES (?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
    sessionUser: db.prepare(
      'SELECT u.id, u.name, u.points, u.last_topup FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    marketCount: db.prepare('SELECT COUNT(*) AS n FROM markets WHERE city_id = ? AND date = ?'),
    insertMarket: db.prepare(
      'INSERT OR IGNORE INTO markets (city_id, date, kind, line, forecast) VALUES (?, ?, ?, ?, ?)'),
    market: db.prepare('SELECT * FROM markets WHERE id = ?'),
    openMarkets: db.prepare("SELECT * FROM markets WHERE status = 'open' ORDER BY date, city_id, kind"),
    marketBets: db.prepare('SELECT id, user_id, side, amount FROM bets WHERE market_id = ?'),
    pools: db.prepare(
      'SELECT market_id, side, SUM(amount) AS total FROM bets GROUP BY market_id, side'),
    insertBet: db.prepare('INSERT INTO bets (market_id, user_id, side, amount) VALUES (?, ?, ?, ?)'),
    debit: db.prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?'),
    credit: db.prepare('UPDATE users SET points = points + ? WHERE id = ?'),
    setPayout: db.prepare('UPDATE bets SET payout = ? WHERE id = ?'),
    settleMarket: db.prepare(
      "UPDATE markets SET status = 'settled', outcome = ?, observed = ? WHERE id = ? AND status = 'open'"),
    userBets: db.prepare(`
      SELECT b.id, b.side, b.amount, b.payout, b.created_at,
             m.id AS market_id, m.city_id, m.date, m.kind, m.line, m.status, m.outcome, m.observed
      FROM bets b JOIN markets m ON m.id = b.market_id
      WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 100`),
    leaderboard: db.prepare('SELECT name, points FROM users ORDER BY points DESC, id LIMIT 20'),
    topup: db.prepare(
      'UPDATE users SET points = ?, last_topup = ? WHERE id = ? AND points < ? AND (last_topup IS NULL OR last_topup < ?)'),
    insertLeague: db.prepare('INSERT INTO leagues (name, code, owner_id) VALUES (?, ?, ?)'),
    leagueByCode: db.prepare('SELECT * FROM leagues WHERE code = ?'),
    leagueCodeExists: db.prepare('SELECT 1 FROM leagues WHERE code = ?'),
    joinLeague: db.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id) VALUES (?, ?)'),
    leaveLeague: db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?'),
    userLeagues: db.prepare(`
      SELECT l.id, l.name, l.code, l.owner_id FROM leagues l
      JOIN league_members lm ON lm.league_id = l.id WHERE lm.user_id = ? ORDER BY l.name`),
    standings: db.prepare(`
      SELECT u.name, u.points FROM league_members lm JOIN users u ON u.id = lm.user_id
      WHERE lm.league_id = ? ORDER BY u.points DESC, u.id`),
  };

  const today = (city) => localDate(city.tz, now());

  function register(name, password) {
    name = String(name ?? '').trim();
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) {
      throw new GameError('Name must be 3–20 letters, numbers, _ or -');
    }
    if (String(password ?? '').length < 6) throw new GameError('Password must be at least 6 characters');
    if (q.userByName.get(name)) throw new GameError('That name is taken', 409);
    const { salt, hash } = hashPassword(password);
    const { lastInsertRowid } = q.insertUser.run(name, hash, salt, STARTING_POINTS);
    return startSession(Number(lastInsertRowid));
  }

  function login(name, password) {
    const user = q.userByName.get(String(name ?? '').trim());
    if (!user || !verifyPassword(String(password ?? ''), user.salt, user.pass_hash)) {
      throw new GameError('Wrong name or password', 401);
    }
    return startSession(user.id);
  }

  function startSession(userId) {
    const token = newToken();
    q.insertSession.run(token, userId);
    return token;
  }

  const utcDay = () => now().toISOString().slice(0, 10);
  const publicUser = (u) => u && {
    id: u.id, name: u.name, points: u.points,
    canTopUp: u.points < TOPUP_POINTS && (u.last_topup ?? '') < utcDay(),
  };
  const userForToken = (token) => (token ? publicUser(q.sessionUser.get(token)) ?? null : null);
  const logout = (token) => q.deleteSession.run(token);

  async function openMarkets() {
    for (const city of cities) {
      const date = addDays(today(city), 1);
      if (q.marketCount.get(city.id, date).n > 0) continue;
      const forecast = (await provider.daily(city)).get(date);
      if (!forecast) continue;
      for (const m of marketsFor(forecast)) q.insertMarket.run(city.id, date, m.kind, m.line, m.forecast);
    }
  }

  async function settleMarkets() {
    const due = q.openMarkets.all().filter((m) => {
      const city = cityById.get(m.city_id);
      return city && today(city) > m.date;
    });
    const byCity = Map.groupBy(due, (m) => m.city_id);
    let settled = 0;
    for (const [cityId, markets] of byCity) {
      const weather = await provider.daily(cityById.get(cityId));
      for (const m of markets) {
        const result = resolve(m, weather.get(m.date));
        if (!result) continue; // data not available yet; try again next tick
        const { value: observed, outcome } = result;
        transaction(db, () => {
          if (q.settleMarket.run(outcome, observed, m.id).changes === 0) return;
          const bets = q.marketBets.all(m.id);
          const payouts = settlePool(bets, outcome);
          for (const bet of bets) {
            const payout = payouts.get(bet.id);
            q.setPayout.run(payout, bet.id);
            if (payout > 0) q.credit.run(payout, bet.user_id);
          }
        });
        settled++;
      }
    }
    return settled;
  }

  function placeBet(userId, marketId, side, amount) {
    amount = Number(amount);
    if (!Number.isInteger(amount) || amount < 1) throw new GameError('Bet a whole number of points');
    if (side !== 0 && side !== 1) throw new GameError('Pick YES or NO');
    return transaction(db, () => {
      const m = q.market.get(marketId);
      if (!m) throw new GameError('No such market', 404);
      if (m.status !== 'open' || today(cityById.get(m.city_id)) >= m.date) {
        throw new GameError('Betting has closed on this market', 409);
      }
      if (q.debit.run(amount, userId, amount).changes === 0) throw new GameError('Not enough points');
      q.insertBet.run(marketId, userId, side, amount);
      return publicUser(q.userById.get(userId));
    });
  }

  function topUp(userId) {
    const day = utcDay();
    if (q.topup.run(TOPUP_POINTS, day, userId, TOPUP_POINTS, day).changes === 0) {
      throw new GameError(`Top-ups are for players under ${TOPUP_POINTS} points, once a day`, 409);
    }
    return publicUser(q.userById.get(userId));
  }

  function createLeague(userId, name) {
    name = String(name ?? '').trim();
    if (name.length < 1 || name.length > 40) throw new GameError('League name must be 1–40 characters');
    return transaction(db, () => {
      let code;
      do {
        code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      } while (q.leagueCodeExists.get(code));
      const { lastInsertRowid } = q.insertLeague.run(name, code, userId);
      q.joinLeague.run(lastInsertRowid, userId);
      return { id: Number(lastInsertRowid), name, code };
    });
  }

  function joinLeague(userId, code) {
    const league = q.leagueByCode.get(String(code ?? '').trim().toUpperCase());
    if (!league) throw new GameError('No league with that code', 404);
    q.joinLeague.run(league.id, userId);
    return { id: league.id, name: league.name, code: league.code };
  }

  function leaveLeague(userId, leagueId) {
    if (q.leaveLeague.run(leagueId, userId).changes === 0) throw new GameError('You are not in that league', 404);
  }

  function myLeagues(userId) {
    return q.userLeagues.all(userId).map((l) => ({
      id: l.id, name: l.name, code: l.code, isOwner: l.owner_id === userId,
      standings: q.standings.all(l.id),
    }));
  }

  function listMarkets(userId) {
    const pools = new Map();
    for (const p of q.pools.all()) {
      const entry = pools.get(p.market_id) ?? { yes: 0, no: 0 };
      entry[p.side === 1 ? 'yes' : 'no'] = p.total;
      pools.set(p.market_id, entry);
    }
    const mine = userId ? q.userBets.all(userId) : [];
    return q.openMarkets.all()
      .filter((m) => today(cityById.get(m.city_id)) < m.date)
      .map((m) => ({
        ...describe(m),
        pool: pools.get(m.id) ?? { yes: 0, no: 0 },
        myBets: mine.filter((b) => b.market_id === m.id).map(({ side, amount }) => ({ side, amount })),
      }));
  }

  function describe(m) {
    const city = cityById.get(m.city_id);
    const kind = MARKET_KINDS[m.kind];
    return {
      id: m.id, cityId: m.city_id, city: city.name, date: m.date, kind: m.kind,
      label: kind.label, unit: kind.unit,
      line: m.line, forecast: m.forecast, status: m.status, outcome: m.outcome,
      observed: m.observed, question: kind.question(city.name, m.line),
    };
  }

  function myBets(userId) {
    return q.userBets.all(userId).map((b) => ({
      id: b.id, side: b.side, amount: b.amount, payout: b.payout, placedAt: b.created_at,
      market: describe({ ...b, id: b.market_id }),
    }));
  }

  const leaderboard = () => q.leaderboard.all();

  async function tick() {
    await openMarkets();
    return settleMarkets();
  }

  return {
    register, login, logout, userForToken, placeBet, listMarkets, myBets, leaderboard, topUp,
    createLeague, joinLeague, leaveLeague, myLeagues,
    openMarkets, settleMarkets, tick,
  };
}
