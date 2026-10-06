// What actually happened, from official weather stations.
//
// UK, Isle of Man and Channel Islands stations send a SYNOP report every
// hour (the coded format weather services swap through the World
// Meteorological Organization). From a day of reports we take:
//   - the high: the highest hourly temperature or reported maximum
//   - rainfall: the sum of the hourly rainfall groups (6RRR5)
//   - the strongest gust: the 910ff / 911ff gust groups
// Reports come from OGIMET, a free archive of WMO reports. Station list:
// NOAA's ISD station history (src/data/uk-stations.json).
import { readFileSync } from 'node:fs';
import { fetchWithRetry } from './weather.js';

export const STATIONS = JSON.parse(readFileSync(new URL('./data/uk-stations.json', import.meta.url), 'utf8'));
const MAX_KM = 50;

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Stations within 50 km of a place, nearest first.
export function stationsNear(place, limit = 3) {
  return STATIONS.map((s) => ({ ...s, km: Math.round(distanceKm(place, s)) }))
    .filter((s) => s.km <= MAX_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}00`;
const localDate = (utc, tz) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(utc);
const temp = (g) => (g[1] === '1' ? -1 : 1) * Number(g.slice(2)) / 10;

// One SYNOP report -> { utc, temp, max, rain1h, gustKmh } (any may be null).
export function parseSynop(line) {
  const [, y, m, d, h, mi, msg] = line.split(',');
  if (!msg?.startsWith('AAXX')) return null;
  const groups = msg.replace(/=+$/, '').trim().split(/\s+/);
  const units = groups[1]?.[4]; // wind unit indicator: 0/1 m/s, 3/4 knots
  const toKmh = units === '3' || units === '4' ? 1.852 : 3.6;
  const s3 = groups.indexOf('333');
  const s5 = groups.indexOf('555');
  const section1 = groups.slice(3, s3 > 0 ? s3 : s5 > 0 ? s5 : undefined);
  const section3 = s3 > 0 ? groups.slice(s3 + 1, s5 > s3 ? s5 : undefined) : [];
  const section5 = s5 > 0 ? groups.slice(s5 + 1) : [];
  // Section 1 starts iRiXhVV Nddff [00fff], then 1sTTT is the air temperature.
  const t = section1.slice(2).find((g) => /^1[01]\d{3}$/.test(g));
  const max = section3.find((g) => /^1[01]\d{3}$/.test(g));
  const rain = [...section3, ...section5].find((g) => /^6\d{3}5$/.test(g));
  let rain1h = null;
  if (rain) {
    const rrr = Number(rain.slice(1, 4));
    rain1h = rrr >= 991 ? (rrr - 990) / 10 : rrr === 990 ? 0.05 : rrr;
  }
  const gusts = section3.filter((g) => /^91[01]\d\d$/.test(g)).map((g) => Number(g.slice(3)) * toKmh);
  return {
    utc: new Date(Date.UTC(+y, m - 1, +d, +h, +mi)),
    temp: t ? temp(t) : null,
    max: max ? temp(max) : null,
    rain1h,
    gustKmh: gusts.length ? Math.max(...gusts) : null,
  };
}

// A local day's readings from one station, or null if the record is too
// patchy to settle a game on (fewer than 22 hourly reports, or rainfall
// missing for more than 2 hours).
export function summariseDay(reports, date, tz) {
  const day = reports.filter((r) => r && localDate(r.utc, tz) === date);
  const hours = new Set(day.map((r) => r.utc.getUTCHours()));
  const rains = day.filter((r) => r.rain1h != null);
  const temps = day.map((r) => r.temp).filter((v) => v != null);
  // Reported maximums cover the previous 12 hours; only trust ones sent
  // late enough in the day not to reach back into yesterday.
  const maxes = day.filter((r) => r.max != null && localHour(r.utc, tz) >= 12).map((r) => r.max);
  const gusts = day.map((r) => r.gustKmh).filter((v) => v != null);
  if (hours.size < 22 || rains.length < 22 || !temps.length) return null;
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    tmax: round1(Math.max(...temps, ...maxes)),
    precip: round1(rains.reduce((a, r) => a + r.rain1h, 0)),
    gust: gusts.length ? round1(Math.max(...gusts)) : null,
    reports: day.length,
  };
}
const localHour = (utc, tz) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(utc));

export function synopObserver({ fetchImpl = fetch } = {}) {
  async function reports(wmo, date) {
    // The local day sits inside this UTC window for UK and nearby time zones.
    const from = new Date(`${date}T00:00:00Z`);
    from.setUTCHours(-3);
    const to = new Date(`${date}T23:00:00Z`);
    to.setUTCHours(26);
    const url = `https://www.ogimet.com/cgi-bin/getsynop?block=${wmo}&begin=${stamp(from)}&end=${stamp(to)}`;
    const res = await fetchWithRetry(url, { fetchImpl });
    if (!res.ok) throw new Error(`OGIMET ${res.status} for ${wmo}`);
    const text = await res.text();
    if (/^Status: /m.test(text)) throw new Error(`OGIMET refused the request for ${wmo}`);
    return text.trim().split('\n').map(parseSynop);
  }
  return {
    name: 'synop',
    // { tmax, precip, gust, station: { wmo, name, km } } from the nearest
    // station with a complete day, or null if none has one (yet).
    async observedDay(place, date) {
      for (const station of stationsNear(place)) {
        try {
          const summary = summariseDay(await reports(station.wmo, date), date, place.tz);
          if (summary?.gust != null) return { ...summary, station: { wmo: station.wmo, name: station.name, km: station.km } };
        } catch (err) {
          console.error(`Station ${station.wmo} (${station.name}): ${err.message}`);
        }
      }
      return null;
    },
  };
}
