import { CITIES, cityById } from './cities.js';
import { transaction } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { settlePool } from './pool.js';
import { localDate, addDays } from './time.js';

export const STARTING_POINTS = 1000;
export const RAIN_LINE_MM = 1.0;

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
    userById: db.prepare('SELECT id, name, points FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (name, pass_hash, salt, points) VALUES (?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
    sessionUser: db.prepare(
      'SELECT u.id, u.name, u.points FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
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

  const userForToken = (token) => (token ? q.sessionUser.get(token) ?? null : null);
  const logout = (token) => q.deleteSession.run(token);

  async function openMarkets() {
    for (const city of cities) {
      const date = addDays(today(city), 1);
      if (q.marketCount.get(city.id, date).n > 0) continue;
      const forecast = (await provider.daily(city)).get(date);
      if (!forecast) continue;
      // Put the temperature line at the forecast rounded, +0.5 so there are no ties.
      q.insertMarket.run(city.id, date, 'temp_over', Math.round(forecast.tmax) + 0.5, forecast.tmax);
      q.insertMarket.run(city.id, date, 'rain', RAIN_LINE_MM, forecast.precip);
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
        const obs = weather.get(m.date);
        if (!obs) continue; // data not available yet; try again next tick
        const observed = m.kind === 'temp_over' ? obs.tmax : obs.precip;
        const outcome = (m.kind === 'temp_over' ? observed > m.line : observed >= m.line) ? 1 : 0;
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
      return q.userById.get(userId);
    });
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
    const question = m.kind === 'temp_over'
      ? `Will the high in ${city.name} be above ${m.line}°C?`
      : `Will ${city.name} get at least ${m.line} mm of rain?`;
    return {
      id: m.id, cityId: m.city_id, city: city.name, date: m.date, kind: m.kind,
      line: m.line, forecast: m.forecast, status: m.status, outcome: m.outcome,
      observed: m.observed, question,
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
    register, login, logout, userForToken, placeBet, listMarkets, myBets, leaderboard,
    openMarkets, settleMarkets, tick,
  };
}
