// Privacy-friendly numbers for the friends test: do people come back the
// next day, and do they share? Most of it comes from the game's own tables.
// The rest are plain daily counts (no names, IDs, cookies or addresses).
import { localDate, addDays } from './time.js';

// The only things the app may count. Anything else is ignored.
export const EVENTS = new Set([
  'visit',            // the app opened
  'intro',            // a first-time visitor saw the intro
  'share-result',     // shared their results
  'share-challenge',  // shared "Reckon you can beat me?"
  'share-league',     // shared a league invite or table
  'open-shared',      // opened a friend's shared result link
  'open-invite',      // opened a league invite link
  'open-push',        // opened the game from a morning notification
]);

const TZ = 'Europe/London';

export function createStats(db, { now = () => new Date() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_counts (
    date  TEXT NOT NULL,
    name  TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (date, name)
  )`);
  const bump = db.prepare(`INSERT INTO daily_counts (date, name, count) VALUES (?, ?, 1)
    ON CONFLICT (date, name) DO UPDATE SET count = count + 1`);

  function count(name) {
    if (!EVENTS.has(name)) return false;
    bump.run(localDate(TZ, now()), name);
    return true;
  }

  // One row per UK day, newest first. You play today for tomorrow's game, so
  // a player "played" on a day if they answered a question in the next
  // day's game, wherever it was.
  function summary(days = 14) {
    const today = localDate(TZ, now());
    const from = addDays(today, -days);
    const game = (day) => addDays(day, 1);
    const players = new Map(db.prepare(`
      SELECT r.date, COUNT(DISTINCT p.user_id) AS n FROM picks p JOIN rounds r ON r.id = p.round_id
      WHERE r.date >= ? GROUP BY r.date`).all(from).map((r) => [r.date, r.n]));
    const firsts = new Map(db.prepare(`
      SELECT first, COUNT(*) AS n FROM (
        SELECT MIN(r.date) AS first FROM picks p JOIN rounds r ON r.id = p.round_id GROUP BY p.user_id
      ) WHERE first >= ? GROUP BY first`).all(from).map((r) => [r.first, r.n]));
    // Players who also played the day before.
    const back = new Map(db.prepare(`
      WITH played AS (SELECT DISTINCT p.user_id, r.date FROM picks p JOIN rounds r ON r.id = p.round_id WHERE r.date >= ?)
      SELECT b.date, COUNT(*) AS n FROM played a JOIN played b ON b.user_id = a.user_id AND b.date = date(a.date, '+1 day')
      GROUP BY b.date`).all(from).map((r) => [r.date, r.n]));
    const counts = {};
    for (const r of db.prepare('SELECT date, name, count FROM daily_counts WHERE date >= ?').all(from)) {
      (counts[r.date] ??= {})[r.name] = r.count;
    }
    const rows = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(today, -i);
      const c = counts[date] ?? {};
      rows.push({
        date,
        players: players.get(game(date)) ?? 0,
        newPlayers: firsts.get(game(date)) ?? 0,
        cameBack: back.get(game(date)) ?? 0,
        playedDayBefore: players.get(date) ?? 0,
        visits: c.visit ?? 0,
        intros: c.intro ?? 0,
        shares: (c['share-result'] ?? 0) + (c['share-challenge'] ?? 0) + (c['share-league'] ?? 0),
        sharedOpens: (c['open-shared'] ?? 0) + (c['open-invite'] ?? 0),
        pushOpens: c['open-push'] ?? 0,
      });
    }
    const totals = db.prepare(`SELECT
      (SELECT COUNT(DISTINCT user_id) FROM picks) AS players,
      (SELECT COUNT(*) FROM users WHERE pass_hash IS NOT NULL) AS savedAccounts,
      (SELECT COUNT(*) FROM leagues) AS leagues,
      (SELECT COUNT(*) FROM league_members) AS leagueMembers,
      (SELECT COUNT(DISTINCT user_id) FROM push_subs) AS notificationsOn`).get();
    return { days: rows, totals: { ...totals } };
  }

  const ping = () => db.prepare('SELECT 1').get();

  return { count, summary, ping };
}
