import { randomInt } from 'node:crypto';
import { transaction } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { localDate, addDays, zonedMidnight, gameNumber } from './time.js';
import { POPULAR } from './places.js';
import { questionsFor, resolveQuestion, describeQuestion } from './questions.js';
import { scoreDay } from './scoring.js';
import { biasFrom } from './bias.js';

// How many recent settled games at a place set its line calibration.
const BIAS_WINDOW = 30;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I lookalikes
const ADJECTIVES = ['Sunny', 'Misty', 'Breezy', 'Stormy', 'Frosty', 'Cloudy', 'Rainy', 'Balmy', 'Gusty', 'Snowy'];
const ANIMALS = ['Otter', 'Puffin', 'Gecko', 'Heron', 'Badger', 'Lynx', 'Walrus', 'Kiwi', 'Meerkat', 'Panda'];

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Settling waits for a weather station's full day of reports (they arrive
// within a couple of hours of midnight), and falls back to the forecast
// model's own values only if no nearby station has a complete record.
const STATION_FIRST_TRY_HOURS = 2;
const STATION_RETRY_MINUTES = 30;
const STATION_GIVE_UP_HOURS = 36;

export function createGame({ db, provider, geocoder, observer = null, now = () => new Date() }) {
  const stationTries = new Map(); // round id -> last attempt (ms)
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
    userById: db.prepare('SELECT name FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (name, pass_hash, salt) VALUES (?, ?, ?)'),
    claimUser: db.prepare('UPDATE users SET name = ?, pass_hash = ?, salt = ? WHERE id = ? AND pass_hash IS NULL'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
    sessionUser: db.prepare(
      'SELECT u.id, u.name, u.pass_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    upsertPlace: db.prepare(`
      INSERT INTO places (id, name, country, lat, lon, tz) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, country = excluded.country`),
    place: db.prepare('SELECT * FROM places WHERE id = ?'),
    round: db.prepare('SELECT * FROM rounds WHERE id = ?'),
    roundFor: db.prepare('SELECT * FROM rounds WHERE place_id = ? AND date = ?'),
    insertRound: db.prepare(
      'INSERT OR IGNORE INTO rounds (place_id, date, questions, sky) VALUES (?, ?, ?, ?)'),
    openRounds: db.prepare("SELECT * FROM rounds WHERE status = 'open'"),
    lastSettled: db.prepare(`
      SELECT * FROM rounds WHERE place_id = ? AND status = 'settled' ORDER BY date DESC LIMIT 1`),
    recentSettled: db.prepare(`
      SELECT questions, results FROM rounds WHERE place_id = ? AND status = 'settled' ORDER BY date DESC LIMIT ?`),
    setBanker: db.prepare(`
      INSERT INTO bankers (round_id, user_id, key) VALUES (?, ?, ?)
      ON CONFLICT (round_id, user_id) DO UPDATE SET key = excluded.key`),
    clearBanker: db.prepare('DELETE FROM bankers WHERE round_id = ? AND user_id = ?'),
    myBanker: db.prepare('SELECT key FROM bankers WHERE round_id = ? AND user_id = ?'),
    roundBankers: db.prepare('SELECT user_id, key FROM bankers WHERE round_id = ?'),
    settleRound: db.prepare(
      "UPDATE rounds SET status = 'settled', results = ? WHERE id = ? AND status = 'open'"),
    upsertPick: db.prepare(`
      INSERT INTO picks (round_id, user_id, key, pick) VALUES (?, ?, ?, ?)
      ON CONFLICT (round_id, user_id, key) DO UPDATE SET pick = excluded.pick`),
    myPicks: db.prepare('SELECT key, pick FROM picks WHERE round_id = ? AND user_id = ?'),
    roundPicks: db.prepare('SELECT user_id, key, pick FROM picks WHERE round_id = ?'),
    crowd: db.prepare('SELECT key, pick, COUNT(*) AS n FROM picks WHERE round_id = ? GROUP BY key, pick'),
    insertScore: db.prepare(
      'INSERT OR IGNORE INTO scores (round_id, user_id, correct, points, detail) VALUES (?, ?, ?, ?, ?)'),
    myScore: db.prepare('SELECT * FROM scores WHERE round_id = ? AND user_id = ?'),
    totals: db.prepare('SELECT COUNT(*) AS played, COALESCE(SUM(points), 0) AS points FROM scores WHERE user_id = ?'),
    pickDates: db.prepare(`
      SELECT DISTINCT r.date FROM picks p JOIN rounds r ON r.id = p.round_id
      WHERE p.user_id = ? ORDER BY r.date DESC LIMIT 400`),
    placeLeaderboard: db.prepare(`
      SELECT u.name, SUM(s.points) AS points, COUNT(*) AS played
      FROM scores s JOIN rounds r ON r.id = s.round_id JOIN users u ON u.id = s.user_id
      WHERE r.place_id = ? AND r.date >= ?
      GROUP BY s.user_id ORDER BY points DESC, played DESC, u.id LIMIT 10`),
    insertLeague: db.prepare('INSERT INTO leagues (name, code, owner_id) VALUES (?, ?, ?)'),
    leagueByCode: db.prepare('SELECT * FROM leagues WHERE code = ?'),
    leagueCodeExists: db.prepare('SELECT 1 FROM leagues WHERE code = ?'),
    joinLeague: db.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id) VALUES (?, ?)'),
    leaveLeague: db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?'),
    userLeagues: db.prepare(`
      SELECT l.id, l.name, l.code, l.owner_id FROM leagues l
      JOIN league_members lm ON lm.league_id = l.id WHERE lm.user_id = ? ORDER BY l.name`),
    standings: db.prepare(`
      SELECT u.name, COALESCE(SUM(s.points), 0) AS points, COUNT(s.round_id) AS played
      FROM league_members lm JOIN users u ON u.id = lm.user_id
      LEFT JOIN scores s ON s.user_id = u.id
      WHERE lm.league_id = ? GROUP BY u.id ORDER BY points DESC, u.id`),
  };

  for (const p of POPULAR) savePlace(p);

  const utcDay = () => now().toISOString().slice(0, 10);
  const publicUser = (u) => u && { id: u.id, name: u.name, guest: u.pass_hash == null };

  // ---- accounts ----------------------------------------------------------

  // Anyone can play straight away as a guest; saving the account (name +
  // password) is only needed to play on another device.
  function createGuest() {
    for (;;) {
      const name = `${pick(ADJECTIVES)}${pick(ANIMALS)}${randomInt(10, 100)}`;
      if (q.userByName.get(name)) continue;
      const { lastInsertRowid } = q.insertUser.run(name, null, null);
      return startSession(Number(lastInsertRowid));
    }
  }

  function validateCredentials(name, password) {
    name = String(name ?? '').trim();
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) throw new GameError('Names need 3 to 20 letters, numbers, _ or -');
    if (String(password ?? '').length < 6) throw new GameError('Password must be at least 6 characters');
    return name;
  }

  function saveAccount(userId, name, password) {
    name = validateCredentials(name, password);
    const existing = q.userByName.get(name);
    if (existing && existing.id !== userId) throw new GameError('That name is taken', 409);
    const { salt, hash } = hashPassword(password);
    if (q.claimUser.run(name, hash, salt, userId).changes === 0) {
      throw new GameError('This account is already saved', 409);
    }
  }

  function login(name, password) {
    const user = q.userByName.get(String(name ?? '').trim());
    if (!user?.pass_hash || !verifyPassword(String(password ?? ''), user.salt, user.pass_hash)) {
      throw new GameError('Wrong name or password', 401);
    }
    return startSession(user.id);
  }

  function startSession(userId) {
    const token = newToken();
    q.insertSession.run(token, userId);
    return token;
  }

  const userForToken = (token) => (token ? publicUser(q.sessionUser.get(token)) ?? null : null);
  const logout = (token) => q.deleteSession.run(token);

  // ---- places ------------------------------------------------------------

  function savePlace(p) {
    q.upsertPlace.run(p.id, p.name, p.country, p.lat, p.lon, p.tz);
  }

  async function searchPlaces(query) {
    query = String(query ?? '').trim();
    if (query.length < 2) return [];
    let results;
    try {
      results = await geocoder.search(query.slice(0, 60));
    } catch (err) {
      console.error('Place search failed:', err.message);
      throw new GameError("Search isn't working right now. Try again in a moment.", 503);
    }
    results.forEach(savePlace);
    return results.map(publicPlace);
  }

  const publicPlace = (p) => ({ id: p.id, name: p.name, country: p.country, tz: p.tz });
  const popularPlaces = () => POPULAR.map(publicPlace);

  function getPlace(id) {
    const place = q.place.get(String(id ?? ''));
    if (!place) throw new GameError('Unknown place', 404);
    return place;
  }

  // ---- rounds ------------------------------------------------------------

  // Tomorrow's game for a place, created from the forecast the first time anyone asks.
  async function currentRound(place) {
    const today = localDate(place.tz, now());
    const date = addDays(today, 1);
    const existing = q.roundFor.get(place.id, date);
    if (existing) return existing;
    let weather;
    try {
      weather = await provider.daily(place);
    } catch (err) {
      console.error('Forecast fetch failed:', err.message);
      throw new GameError("Couldn't reach the weather service. Try again in a moment.", 503);
    }
    const tomorrow = weather.get(date);
    if (!tomorrow) throw new GameError('No forecast available for this place yet', 503);
    q.insertRound.run(place.id, date, JSON.stringify(questionsFor(tomorrow, placeBias(place.id))), tomorrow.code);
    return q.roundFor.get(place.id, date);
  }

  // How this place's highs and gusts have recently run against the forecast,
  // from its own settled games, so tomorrow's lines are fair coin flips.
  function placeBias(placeId) {
    const history = q.recentSettled.all(placeId, BIAS_WINDOW).map((r) => {
      const questions = Object.fromEntries(JSON.parse(r.questions).map((x) => [x.key, x]));
      const results = JSON.parse(r.results);
      const diff = (key) => (questions[key] && results[key] ? results[key].observed - questions[key].forecast : null);
      return { temp: diff('temp'), wind: diff('wind') };
    });
    return biasFrom(history);
  }

  function crowdFor(roundId) {
    const crowd = {};
    for (const { key, pick, n } of q.crowd.all(roundId)) {
      crowd[key] ??= { yes: 0, no: 0 };
      crowd[key][pick ? 'yes' : 'no'] = n;
    }
    return crowd;
  }

  function roundView(round, place, userId) {
    const mine = Object.fromEntries(q.myPicks.all(round.id, userId ?? -1).map((p) => [p.key, p.pick]));
    const crowd = crowdFor(round.id);
    const results = round.results ? JSON.parse(round.results) : null;
    const score = userId ? q.myScore.get(round.id, userId) : null;
    const detail = score ? JSON.parse(score.detail) : {};
    const banker = userId ? q.myBanker.get(round.id, userId)?.key ?? null : null;
    return {
      id: round.id,
      number: gameNumber(round.date),
      date: round.date,
      closesAt: zonedMidnight(round.date, place.tz).toISOString(),
      sky: round.sky,
      status: round.status,
      questions: JSON.parse(round.questions).map((question) => ({
        ...describeQuestion(question),
        myPick: mine[question.key] ?? null,
        crowd: crowd[question.key] ?? { yes: 0, no: 0 },
        result: results?.[question.key] ?? null,
        score: detail[question.key] ?? null,
      })),
      banker,
      source: results?.source ?? null,
      score: score && { correct: score.correct, points: score.points },
    };
  }

  // Everything the main screen needs for one place.
  async function view(userId, placeId) {
    const place = getPlace(placeId);
    const round = await currentRound(place);
    const last = q.lastSettled.get(place.id);
    return {
      place: publicPlace(place),
      round: roundView(round, place, userId),
      lastRound: last ? roundView(last, place, userId) : null,
      leaderboard: q.placeLeaderboard.all(place.id, addDays(round.date, -7)),
      stats: userId ? stats(userId) : null,
    };
  }

  function openRound(roundId, key) {
    const round = q.round.get(roundId);
    if (!round) throw new GameError('No such game', 404);
    const place = getPlace(round.place_id);
    if (round.status !== 'open' || localDate(place.tz, now()) >= round.date) {
      throw new GameError('This game is locked', 409);
    }
    if (key != null && !JSON.parse(round.questions).some((x) => x.key === key)) throw new GameError('No such question');
    return { round, place };
  }

  function makePick(userId, roundId, key, value) {
    if (value !== 0 && value !== 1) throw new GameError('Pick yes or no');
    const { round, place } = openRound(roundId, key);
    q.upsertPick.run(round.id, userId, key, value);
    return roundView(round, place, userId);
  }

  // One call a day can be your banker, worth double. key null clears it.
  function setBanker(userId, roundId, key) {
    const { round, place } = openRound(roundId, key);
    if (key == null) q.clearBanker.run(round.id, userId);
    else q.setBanker.run(round.id, userId, key);
    return roundView(round, place, userId);
  }

  // ---- settlement ----------------------------------------------------------

  function scoreRound(round, results) {
    const questions = JSON.parse(round.questions);
    const bankers = new Map(q.roundBankers.all(round.id).map((b) => [b.user_id, b.key]));
    const byUser = Map.groupBy(q.roundPicks.all(round.id), (p) => p.user_id);
    for (const [userId, userPicks] of byUser) {
      const picks = Object.fromEntries(userPicks.map((p) => [p.key, p.pick]));
      const { correct, points, detail } = scoreDay(questions, results, picks, bankers.get(userId));
      q.insertScore.run(round.id, userId, correct, points, JSON.stringify(detail));
    }
  }

  // What happened on a round's day: { values, source } or null to wait.
  async function observedFor(round, place) {
    const hoursSinceEnd = (now() - zonedMidnight(addDays(round.date, 1), place.tz)) / 3_600_000;
    if (observer) {
      if (hoursSinceEnd < STATION_FIRST_TRY_HOURS) return null;
      const last = stationTries.get(round.id) ?? 0;
      if (now() - last >= STATION_RETRY_MINUTES * 60_000) {
        stationTries.set(round.id, +now());
        const obs = await observer.observedDay(place, round.date);
        if (obs) {
          stationTries.delete(round.id);
          return { values: obs, source: { type: 'station', name: obs.station.name, wmo: obs.station.wmo, km: obs.station.km } };
        }
      }
      if (hoursSinceEnd < STATION_GIVE_UP_HOURS) return null;
    }
    const day = (await provider.daily(place)).get(round.date);
    return day ? { values: day, source: { type: 'model' } } : null;
  }

  async function settleRounds() {
    const due = q.openRounds.all().filter((r) => localDate(q.place.get(r.place_id).tz, now()) > r.date);
    let settled = 0;
    for (const round of due) {
      const place = q.place.get(round.place_id);
      let observed;
      try {
        observed = await observedFor(round, place);
      } catch (err) {
        console.error(`Settling ${place.name} ${round.date}:`, err.message);
        continue;
      }
      if (!observed) continue; // not in yet; retry next tick
      const weather = new Map([[round.date, observed.values]]);
      const results = {};
      for (const question of JSON.parse(round.questions)) {
        results[question.key] = resolveQuestion(question, weather, round.date);
      }
      if (Object.values(results).some((r) => r == null)) continue;
      transaction(db, () => {
        if (q.settleRound.run(JSON.stringify({ ...results, source: observed.source }), round.id).changes) {
          scoreRound(round, results);
        }
      });
      settled++;
    }
    return settled;
  }


  // ---- stats & leagues -------------------------------------------------

  // Days in a row with a game played; still alive if the latest is no older than yesterday.
  function stats(userId) {
    const dates = q.pickDates.all(userId).map((r) => r.date);
    let streak = 0;
    if (dates.length && dates[0] >= addDays(utcDay(), -1)) {
      streak = 1;
      while (streak < dates.length && dates[streak] === addDays(dates[0], -streak)) streak++;
    }
    return { ...q.totals.get(userId), streak };
  }

  function createLeague(userId, name) {
    name = String(name ?? '').trim();
    if (name.length < 1 || name.length > 40) throw new GameError('League names can be up to 40 characters');
    return transaction(db, () => {
      let code;
      do {
        code = Array.from({ length: 6 }, () => pick(CODE_ALPHABET)).join('');
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

  // What an invite link shows before you join.
  function leaguePreview(code) {
    const league = q.leagueByCode.get(String(code ?? '').trim().toUpperCase());
    if (!league) throw new GameError('No league with that code', 404);
    const members = q.standings.all(league.id);
    return { name: league.name, code: league.code, members: members.length, owner: q.userById.get(league.owner_id)?.name };
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

  return {
    createGuest, saveAccount, login, logout, userForToken,
    searchPlaces, popularPlaces, view, makePick, setBanker, settleRounds, stats,
    createLeague, joinLeague, leaveLeague, myLeagues, leaguePreview,
    tick: settleRounds,
  };
}

function pick(list) {
  return list[randomInt(list.length)];
}
