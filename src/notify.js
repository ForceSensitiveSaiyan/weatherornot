// Morning notifications: "You called it. 3/3 in Douglas", once each game
// settles, but never before 7.30 in the morning.
import { checkSubscription } from './push.js';
import { localDate, addDays } from './time.js';
import { weatherLine, sourceName, vsLine } from '../public/words.js';
import { GameError } from './game.js';

const EARLIEST = '07:30';
const LATEST = '21:00'; // a game that settles very late isn't worth a buzz in the night
const MAX_DEVICES = 5;

export function createNotifier({ db, push, now = () => new Date() }) {
  const q = {
    upsert: db.prepare(`
      INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    trim: db.prepare(`
      DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN
        (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_DEVICES})`),
    remove: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
    subsFor: db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
    // Settled scores from the last couple of days for players with notifications on.
    due: db.prepare(`
      SELECT s.user_id, s.correct, s.points, r.id AS round_id, r.date, r.questions, r.results, p.name AS place, p.tz
      FROM scores s JOIN rounds r ON r.id = s.round_id JOIN places p ON p.id = r.place_id
      WHERE r.date >= ? AND s.user_id IN (SELECT user_id FROM push_subs)
        AND NOT EXISTS (SELECT 1 FROM push_sent x WHERE x.round_id = s.round_id AND x.user_id = s.user_id)`),
    markSent: db.prepare('INSERT OR IGNORE INTO push_sent (round_id, user_id) VALUES (?, ?)'),
  };

  function subscribe(userId, sub) {
    const s = checkSubscription(sub);
    if (!s) throw new GameError("This browser can't do notifications here.");
    q.upsert.run(s.endpoint, userId, s.p256dh, s.auth);
    q.trim.run(userId, userId);
  }

  const unsubscribe = (endpoint) => q.remove.run(String(endpoint ?? ''));

  // Sends any results that are in, during the morning after the game's day.
  async function morning() {
    if (!push) return 0;
    const at = now();
    let sent = 0;
    for (const row of q.due.all(addDays(at.toISOString().slice(0, 10), -2))) {
      const today = localDate(row.tz, at);
      if (row.date !== addDays(today, -1)) {
        if (row.date < addDays(today, -1)) q.markSent.run(row.round_id, row.user_id); // too late now
        continue;
      }
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: row.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      if (time < EARLIEST || time >= LATEST) continue;
      q.markSent.run(row.round_id, row.user_id);
      const message = resultMessage(row);
      for (const sub of q.subsFor.all(row.user_id)) {
        const outcome = await push.send(sub, message);
        if (outcome === 'gone') unsubscribe(sub.endpoint);
        if (outcome === 'sent') sent++;
      }
    }
    return sent;
  }

  return { subscribe, unsubscribe, morning, publicKey: push?.publicKey ?? null };
}

// "You called it. 3/3 in Douglas" / "Ronaldsway Airport: dry, 13.7°C, gusts 40 mph. Same as the forecast."
export function resultMessage({ round_id: roundId, correct, place, questions, results }) {
  questions = JSON.parse(questions);
  results = JSON.parse(results);
  const of = questions.filter((x) => results[x.key]?.answer != null).length;
  const forecast = results.forecast ? Object.values(results.forecast).filter((x) => x === true).length : null;
  const what = weatherLine(questions.map((x) => ({ key: x.key, observed: results[x.key]?.observed })));
  const vs = vsLine(correct, of, forecast);
  return {
    title: of && correct === of ? `You called it. ${correct}/${of} in ${place}` : `${correct}/${of} in ${place}`,
    body: `${sourceName(results.source)}: ${what}.${vs ? ` ${vs}` : ''}`,
    tag: `results-${roundId}`,
    url: '/?from=push',
  };
}
