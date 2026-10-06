import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSynop, summariseDay, stationsNear } from '../src/observations.js';
import { openDb } from '../src/db.js';
import { createGame } from '../src/game.js';
import { mockGeocoder } from '../src/places.js';

// A day of hourly reports for Ronaldsway (03204). The local day of 4 Oct 2026
// in BST runs from 23:00 UTC on the 3rd to 22:00 UTC on the 4th.
function dayOfReports({ count = 24, units = '4' } = {}) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const utc = new Date(Date.UTC(2026, 9, 3, 23 + i));
    const [y, m, d, h] = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours()];
    const pad = (n) => String(n).padStart(2, '0');
    const t = h === 15 ? 164 : 100 + i * 2;                                 // 16.4°C at 15:00, else 10.0 rising
    const rain = h === 10 ? '60035' : h === 11 ? '69925' : '60005';         // 3 mm, then 0.2 mm
    const gust = h === 14 ? '91130' : '91112';                               // 30 knots at 14:00
    const max = h === 18 ? ' 10169' : '';                                    // reported 12-hour max 16.9°C
    lines.push(`03204,${y},${pad(m)},${pad(d)},${pad(h)},00,AAXX ${pad(d)}${pad(h)}${units} 03204 25580 82013 1${String(t).padStart(4, '0')} 20107 30245 40265 57008 333${max} 55300 ${rain} ${gust}==`);
  }
  return lines;
}

test('a day of SYNOP reports becomes a high, a rainfall total and the top gust', () => {
  const day = summariseDay(dayOfReports().map(parseSynop), '2026-10-04', 'Europe/Isle_of_Man');
  // The reported maximum beats the hourly readings; 3 + 0.2 mm of rain; 30 knots = 55.6 km/h.
  assert.deepEqual(day, { tmax: 16.9, precip: 3.2, gust: 55.6, reports: 24 });
});

test('wind in metres per second is converted too, and patchy days are refused', () => {
  const ms = summariseDay(dayOfReports({ units: '1' }).map(parseSynop), '2026-10-04', 'Europe/Isle_of_Man');
  assert.equal(ms.gust, 108); // 30 m/s
  assert.equal(summariseDay(dayOfReports({ count: 20 }).map(parseSynop), '2026-10-04', 'Europe/Isle_of_Man'), null);
  assert.equal(parseSynop('03204,2026,10,04,14,00,NIL=='), null);
});

test('places map to the nearest stations within 50 km', () => {
  const [ronaldsway] = stationsNear({ lat: 54.15, lon: -4.4833 });
  assert.deepEqual([ronaldsway.wmo, ronaldsway.name, ronaldsway.km], ['03204', 'Ronaldsway Airport', 12]);
  assert.deepEqual(stationsNear({ lat: 40.7, lon: -74 }), []); // New York: no UK station, so the model settles it
});

test('settling waits for the station, uses it, and falls back to the model after 36 hours', async () => {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const forecast = { tmax: 17.8, precip: 3.2, gust: 41, code: 61 };
  const model = new Map([['2026-10-06', forecast]]);
  let station = null;
  let calls = 0;
  const game = createGame({
    db: openDb(), geocoder: mockGeocoder(), now: () => clock.now,
    provider: { daily: async () => model },
    observer: { observedDay: async () => (calls++, station) },
  });
  const LONDON = 'gn:2643743';
  const MANCHESTER = 'gn:2643123';
  const london = (await game.view(null, LONDON)).round;
  const manc = (await game.view(null, MANCHESTER)).round;
  const u = game.userForToken(game.createGuest());
  game.makePick(u.id, london.id, 'rain', 1);
  game.makePick(u.id, manc.id, 'rain', 1);
  model.set('2026-10-06', { ...forecast, precip: 0 }); // the model thinks it stayed dry

  clock.now = new Date('2026-10-06T23:30:00Z'); // 30 minutes after the day ended in London
  assert.equal(await game.settleRounds(), 0);
  assert.equal(calls, 0, 'too early to ask the station');

  clock.now = new Date('2026-10-07T02:00:00Z');
  assert.equal(await game.settleRounds(), 0);
  assert.equal(calls, 2, 'asked once per game, station not in yet');
  clock.now = new Date('2026-10-07T02:10:00Z');
  await game.settleRounds();
  assert.equal(calls, 2, 'waits 30 minutes before asking again');

  // The station's report lands for London; it rained 4 mm there.
  station = { tmax: 16, precip: 4, gust: 50, station: { wmo: '03772', name: 'London Heathrow', km: 23 } };
  clock.now = new Date('2026-10-07T02:40:00Z');
  assert.equal(await game.settleRounds(), 2);
  model.set('2026-10-08', forecast);
  const v = await game.view(u.id, LONDON);
  assert.deepEqual(v.lastRound.source, { type: 'station', name: 'London Heathrow', wmo: '03772', km: 23 });
  assert.equal(v.lastRound.questions[0].result.observed, 4);
  assert.equal(v.lastRound.score.correct, 1);
});

test('with no station data at all, the model settles it once 36 hours have passed', async () => {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const model = new Map([['2026-10-06', { tmax: 17.8, precip: 0, gust: 41, code: 3 }]]);
  const game = createGame({
    db: openDb(), geocoder: mockGeocoder(), now: () => clock.now,
    provider: { daily: async () => model }, observer: { observedDay: async () => null },
  });
  await game.view(null, 'gn:2643743');
  clock.now = new Date('2026-10-08T10:00:00Z'); // 35 hours after the day ended
  assert.equal(await game.settleRounds(), 0);
  clock.now = new Date('2026-10-08T11:30:00Z');
  model.set('2026-10-09', model.get('2026-10-06'));
  assert.equal(await game.settleRounds(), 1);
  assert.deepEqual((await game.view(null, 'gn:2643743')).lastRound.source, { type: 'model' });
});
