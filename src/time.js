// Calendar date (YYYY-MM-DD) it currently is in the given IANA time zone.
export function localDate(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Milliseconds the given zone is ahead of UTC at the given instant.
function zoneOffset(tz, instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// The instant local midnight starts `date` in `tz`.
export function zonedMidnight(date, tz) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - zoneOffset(tz, guess);
  t = guess - zoneOffset(tz, t); // second pass handles DST changes near midnight
  return new Date(t);
}

// Days since 1 Oct 2026, so every daily game has a number like Wordle's.
export function gameNumber(date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse('2026-10-01T00:00:00Z')) / 86_400_000) + 1;
}

// The Monday on or before a date (weeks run Monday to Sunday).
export function mondayOf(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

// First and last day of the month before the one a date falls in.
export function previousMonth(date) {
  const first = `${date.slice(0, 7)}-01`;
  const last = addDays(first, -1);
  return { from: `${last.slice(0, 7)}-01`, to: last };
}
