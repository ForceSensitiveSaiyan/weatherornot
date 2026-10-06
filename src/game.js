import { randomInt } from 'node:crypto';
import { transaction } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { localDate, addDays, zonedMidnight, gameNumber, mondayOf, previousMonth } from './time.js';
import { stationsNear, isPlayable, nearestStationKm, PLAYABLE_KM } from './observations.js';
import { POPULAR } from './places.js';
import { questionsFor, resolveQuestion, describeQuestion, forecastCall } from './questions.js';
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
    guestOpenRounds: db.prepare(`
      SELECT DISTINCT p.round_id FROM picks p JOIN rounds r ON r.id = p.round_id
      WHERE p.user_id = ? AND r.status = 'open'`),
    hasPicks: db.prepare('SELECT 1 FROM picks WHERE round_id = ? AND user_id = ? LIMIT 1'),
    movePicks: db.prepare('UPDATE picks SET user_id = ? WHERE round_id = ? AND user_id = ?'),
    moveBanker: db.prepare('UPDATE bankers SET user_id = ? WHERE round_id = ? AND user_id = ?'),
    lastPlace: db.prepare(`
      SELECT pl.* FROM picks p JOIN rounds r ON r.id = p.round_id JOIN places pl ON pl.id = r.place_id
      WHERE p.user_id = ? ORDER BY r.date DESC, p.rowid DESC LIMIT 1`),
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
    insertReport: db.prepare('INSERT OR IGNORE INTO reports (round_id, user_id, key, message) VALUES (?, ?, ?, ?)'),
    openReports: db.prepare(`
      SELECT rp.id, rp.round_id, rp.key, rp.message, rp.created_at, u.name AS user, r.date, r.questions, r.results,
             p.name AS place
      FROM reports rp JOIN rounds r ON r.id = rp.round_id JOIN users u ON u.id = rp.user_id
      JOIN places p ON p.id = r.place_id
      WHERE rp.status = 'open' ORDER BY rp.id`),
    setReportStatus: db.prepare('UPDATE reports SET status = ? WHERE id = ?'),
    voidReports: db.prepare("UPDATE reports SET status = 'voided' WHERE round_id = ? AND (key = ? OR key IS NULL) AND status = 'open'"),
    setResults: db.prepare('UPDATE rounds SET results = ? WHERE id = ?'),
    deleteScores: db.prepare('DELETE FROM scores WHERE round_id = ?'),
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
      WHERE r.place_id = ? AND r.date BETWEEN ? AND ?
      GROUP BY s.user_id ORDER BY points DESC, played DESC, u.id LIMIT 10`),
    recentScores: db.prepare(`
      SELECT s.detail, r.results FROM scores s JOIN rounds r ON r.id = s.round_id
      WHERE s.user_id = ? AND r.date >= ?`),
    insertLeague: db.prepare('INSERT INTO leagues (name, code, owner_id) VALUES (?, ?, ?)'),
    leagueByCode: db.prepare('SELECT * FROM leagues WHERE code = ?'),
    leagueCodeExists: db.prepare('SELECT 1 FROM leagues WHERE code = ?'),
    joinLeague: db.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id) VALUES (?, ?)'),
    leaveLeague: db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?'),
    userLeagues: db.prepare(`
      SELECT l.id, l.name, l.code, l.owner_id FROM leagues l
      JOIN league_members lm ON lm.league_id = l.id WHERE lm.user_id = ? ORDER BY l.name`),
    standings: db.prepare(`
      SELECT u.name, COALESCE(SUM(x.points), 0) AS points, COUNT(x.round_id) AS played
      FROM league_members lm JOIN users u ON u.id = lm.user_id
      LEFT JOIN (SELECT s.user_id, s.points, s.round_id FROM scores s JOIN rounds r ON r.id = s.round_id
                 WHERE r.date BETWEEN ? AND ?) x ON x.user_id = u.id
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
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) throw new GameError('Names need 3 to 20 characters: letters, numbers, _ or -');
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
  const logout = (token) => q.deleteSession.run(String(token));

  // When a guest logs into a saved account, their answers to games still open
  // carry over, unless the account already answered that game.
  function mergeGuest(guestId, accountId) {
    if (guestId === accountId) return 0;
    return transaction(db, () => {
      let moved = 0;
      for (const { round_id: roundId } of q.guestOpenRounds.all(guestId)) {
        if (q.hasPicks.get(roundId, accountId)) continue;
        moved += q.movePicks.run(accountId, roundId, guestId).changes;
        q.moveBanker.run(accountId, roundId, guestId);
      }
      return moved;
    });
  }

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

  // Search results say whether each town is close enough to a weather station to play.
  const publicPlace = (p) => ({
    id: p.id, name: p.name, country: p.country, tz: p.tz,
    playable: isPlayable(p), stationKm: nearestStationKm(p),
  });
  const popularPlaces = () => POPULAR.map(publicPlace);

  // A place by id, for share links: { id, name, ... } or a 404.
  function placeInfo(id) {
    const place = q.place.get(String(id ?? ''));
    if (!place) throw new GameError("We don't know that place. Pick your town again?", 404);
    return publicPlace(place);
  }

  function getPlace(id) {
    const place = q.place.get(String(id ?? ''));
    if (!place) throw new GameError("We don't know that place. Pick your town again?", 404);
    if (!isPlayable(place)) {
      throw new GameError(`${place.name} is more than ${PLAYABLE_KM} km from a weather station we can use, so results wouldn't be fair. Try the nearest bigger town.`, 422);
    }
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
      const diff = (key) => (questions[key] && results[key] && !results[key].voided
        ? results[key].observed - questions[key].forecast : null);
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
      forecast: results?.forecast ? {
        correct: Object.values(results.forecast).filter((x) => x === true).length,
        total: Object.values(results.forecast).filter((x) => x != null).length,
      } : null,
      score: score && { correct: score.correct, points: score.points },
    };
  }

  // Everything the main screen needs for one place.
  async function view(userId, placeId) {
    const place = getPlace(placeId);
    const round = await currentRound(place);
    const last = q.lastSettled.get(place.id);
    const week = thisWeek();
    return {
      place: publicPlace(place),
      round: roundView(round, place, userId),
      lastRound: last ? roundView(last, place, userId) : null,
      station: stationsNear(place, 1)[0] ?? null,
      leaderboard: q.placeLeaderboard.all(place.id, week.from, week.to),
      champion: champion(q.placeLeaderboard.all(place.id, addDays(week.from, -7), addDays(week.from, -1))),
      stats: userId ? stats(userId) : null,
    };
  }

  const OOPS = 'Something went wrong. Refresh and try again.';

  function openRound(roundId, key) {
    if (key !== null && typeof key !== 'string') throw new GameError(OOPS);
    const round = q.round.get(roundId);
    if (!round) throw new GameError('Something went wrong. Refresh and try again.', 404);
    const place = getPlace(round.place_id);
    if (round.status !== 'open' || localDate(place.tz, now()) >= round.date) {
      throw new GameError('Too late, answers for this day have closed.', 409);
    }
    if (key != null && !JSON.parse(round.questions).some((x) => x.key === key)) throw new GameError('Something went wrong. Refresh and try again.');
    return { round, place };
  }

  // Checks that don't need a player, so the server can refuse junk before
  // creating a guest account.
  function checkPick(roundId, key, value) {
    if (typeof key !== 'string') throw new GameError(OOPS);
    if (value !== 0 && value !== 1) throw new GameError('Pick yes or no');
    openRound(roundId, key);
  }
  const checkBanker = (roundId, key) => openRound(roundId, key);

  function makePick(userId, roundId, key, value) {
    checkPick(roundId, key, value);
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
        // How the forecast alone would have done, for "you vs the forecast".
        const forecast = Object.fromEntries(JSON.parse(round.questions).map((x) => [
          x.key, results[x.key].answer == null ? null : forecastCall(x) === results[x.key].answer]));
        if (q.settleRound.run(JSON.stringify({ ...results, source: observed.source, forecast }), round.id).changes) {
          scoreRound(round, results);
        }
      });
      settled++;
    }
    return settled;
  }


  // ---- reports and voiding -------------------------------------------------

  // A player thinks a result is wrong (usually a station glitch). One report
  // per player per game, on games settled in the last two weeks.
  function reportProblem(userId, roundId, key, message) {
    const round = q.round.get(roundId);
    if (!round || round.status !== 'settled') throw new GameError('Something went wrong. Refresh and try again.', 404);
    if (round.date < addDays(utcDay(), -14)) throw new GameError("That game's too old to report now.", 409);
    if (key != null && !JSON.parse(round.questions).some((x) => x.key === key)) {
      throw new GameError('Something went wrong. Refresh and try again.');
    }
    message = String(message ?? '').trim().slice(0, 500);
    if (message.length < 3) throw new GameError('Tell us a little about what looks wrong.');
    if (q.insertReport.run(roundId, userId, key, message).changes === 0) {
      throw new GameError("You've already reported this game. We'll take a look.", 409);
    }
  }

  function listReports() {
    return q.openReports.all().map((r) => {
      const question = JSON.parse(r.questions).find((x) => x.key === r.key);
      const results = JSON.parse(r.results);
      return {
        id: r.id, roundId: r.round_id, place: r.place, date: r.date, user: r.user, message: r.message,
        key: r.key, question: question ? describeQuestion(question).title : null,
        line: question?.line ?? null, observed: r.key ? results[r.key]?.observed ?? null : null,
        source: results.source ?? null, reportedAt: r.created_at,
      };
    });
  }

  // Void one question of a settled game for everyone: it scores 5 (10 if
  // doubled) for anyone who answered, and everyone's points are recalculated.
  function voidQuestion(roundId, key, reason) {
    const round = q.round.get(roundId);
    if (!round || round.status !== 'settled') throw new GameError('No settled game with that id', 404);
    if (typeof key !== 'string' || !JSON.parse(round.questions).some((x) => x.key === key)) throw new GameError('No such question', 400);
    reason = String(reason ?? '').trim().slice(0, 200) || 'the station reading looked wrong';
    transaction(db, () => {
      const results = JSON.parse(round.results);
      results[key] = { ...results[key], answer: null, voided: reason };
      if (results.forecast) results.forecast[key] = null;
      q.setResults.run(JSON.stringify(results), round.id);
      q.deleteScores.run(round.id);
      scoreRound(round, results);
      q.voidReports.run(round.id, key);
    });
  }

  function dismissReport(reportId) {
    if (q.setReportStatus.run('dismissed', reportId).changes === 0) throw new GameError('No such report', 404);
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
    const last = q.lastPlace.get(userId);
    return { ...q.totals.get(userId), streak, vsForecast: vsForecast(userId), lastPlace: last ? publicPlace(last) : null };
  }

  // Over the last 30 days, on the calls you made: how often you were right,
  // and how often the forecast on its own would have been.
  function vsForecast(userId) {
    let calls = 0, you = 0, forecast = 0;
    for (const row of q.recentScores.all(userId, addDays(utcDay(), -30))) {
      const detail = JSON.parse(row.detail);
      const fc = JSON.parse(row.results)?.forecast ?? {};
      for (const [key, d] of Object.entries(detail)) {
        if (d.correct == null || fc[key] == null) continue;
        calls++;
        you += d.correct ? 1 : 0;
        forecast += fc[key] ? 1 : 0;
      }
    }
    return { calls, you, forecast };
  }

  // Monday to Sunday, by game date.
  function thisWeek() {
    const from = mondayOf(utcDay());
    return { from, to: addDays(from, 6) };
  }

  // Top of a table, ties shared; nobody if nobody scored.
  function champion(rows) {
    const top = rows[0]?.points;
    if (!top) return null;
    return { names: rows.filter((r) => r.points === top).map((r) => r.name), points: top };
  }

  function checkLeagueName(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) {
      throw new GameError('Give your league a name (40 characters max).');
    }
  }

  function createLeague(userId, name) {
    checkLeagueName(name);
    name = String(name ?? '').trim();
    if (name.length < 1 || name.length > 40) throw new GameError('Give your league a name (40 characters max).');
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
    if (!league) throw new GameError("We can't find that league. Check the link?", 404);
    q.joinLeague.run(league.id, userId);
    return { id: league.id, name: league.name, code: league.code };
  }

  // What an invite link shows before you join.
  function leaguePreview(code) {
    const league = q.leagueByCode.get(String(code ?? '').trim().toUpperCase());
    if (!league) throw new GameError("We can't find that league. Check the link?", 404);
    const members = q.standings.all('0000-00-00', '9999-12-31', league.id);
    return { name: league.name, code: league.code, members: members.length, owner: q.userById.get(league.owner_id)?.name };
  }

  function leaveLeague(userId, leagueId) {
    if (q.leaveLeague.run(leagueId, userId).changes === 0) throw new GameError("You're not in that league.", 404);
  }

  function myLeagues(userId) {
    const week = thisWeek();
    return q.userLeagues.all(userId).map((l) => ({
      id: l.id, name: l.name, code: l.code, isOwner: l.owner_id === userId,
      standings: q.standings.all(week.from, week.to, l.id),
      champion: monthChampion(l.id),
    }));
  }

  // Last calendar month's league winner, e.g. { month: 'September', names, points }.
  function monthChampion(leagueId) {
    const { from, to } = previousMonth(utcDay());
    const best = champion(q.standings.all(from, to, leagueId));
    if (!best) return null;
    const month = new Date(`${from}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
    return { month, ...best };
  }

  return {
    createGuest, saveAccount, login, logout, userForToken,
    searchPlaces, popularPlaces, placeInfo, view, makePick, setBanker, settleRounds, stats,
    checkPick, checkBanker, checkLeagueName, validateCredentials, mergeGuest,
    reportProblem, listReports, voidQuestion, dismissReport,
    createLeague, joinLeague, leaveLeague, myLeagues, leaguePreview,
    tick: settleRounds,
  };
}

function pick(list) {
  return list[randomInt(list.length)];
}
