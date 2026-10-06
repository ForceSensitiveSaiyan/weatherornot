import { fetchWithRetry } from './weather.js';

// Places are identified by their GeoNames id ("gn:<id>"), which is what
// Open-Meteo's geocoding API returns, so a city searched for by two players
// always lands on the same daily game and leaderboard.
//
// WeatherOrNot is for the UK, the Isle of Man and the Channel Islands only:
// that's where we can settle games on official weather station reports.
export const POPULAR = [
  { id: 'gn:2643743', name: 'London', country: 'England', lat: 51.5085, lon: -0.1257, tz: 'Europe/London' },
  { id: 'gn:2655603', name: 'Birmingham', country: 'England', lat: 52.4814, lon: -1.8998, tz: 'Europe/London' },
  { id: 'gn:2643123', name: 'Manchester', country: 'England', lat: 53.4809, lon: -2.2374, tz: 'Europe/London' },
  { id: 'gn:2648579', name: 'Glasgow', country: 'Scotland', lat: 55.8651, lon: -4.2576, tz: 'Europe/London' },
  { id: 'gn:2644688', name: 'Leeds', country: 'England', lat: 53.7965, lon: -1.5478, tz: 'Europe/London' },
  { id: 'gn:2644210', name: 'Liverpool', country: 'England', lat: 53.4106, lon: -2.9779, tz: 'Europe/London' },
  { id: 'gn:2638077', name: 'Sheffield', country: 'England', lat: 53.383, lon: -1.4659, tz: 'Europe/London' },
  { id: 'gn:2650225', name: 'Edinburgh', country: 'Scotland', lat: 55.9521, lon: -3.1965, tz: 'Europe/London' },
  { id: 'gn:2654675', name: 'Bristol', country: 'England', lat: 51.4552, lon: -2.5966, tz: 'Europe/London' },
  { id: 'gn:2653822', name: 'Cardiff', country: 'Wales', lat: 51.48, lon: -3.18, tz: 'Europe/London' },
  { id: 'gn:2655984', name: 'Belfast', country: 'Northern Ireland', lat: 54.5968, lon: -5.9254, tz: 'Europe/London' },
  { id: 'gn:2641673', name: 'Newcastle upon Tyne', country: 'England', lat: 54.9733, lon: -1.614, tz: 'Europe/London' },
  { id: 'gn:2641170', name: 'Nottingham', country: 'England', lat: 52.9536, lon: -1.1505, tz: 'Europe/London' },
  { id: 'gn:2654710', name: 'Brighton', country: 'England', lat: 50.8284, lon: -0.1395, tz: 'Europe/London' },
  { id: 'gn:3042237', name: 'Douglas', country: 'Isle of Man', lat: 54.15, lon: -4.4833, tz: 'Europe/Isle_of_Man' },
];

// The UK plus the Crown Dependencies, which have their own country codes.
const HOME = { GB: null, IM: 'Isle of Man', JE: 'Jersey', GG: 'Guernsey' };
const isHome = (r) => r.country_code in HOME;
const homeLabel = (r) => HOME[r.country_code] ?? r.admin1 ?? 'United Kingdom';

export function openMeteoGeocoder({ fetchImpl = fetch } = {}) {
  async function lookup(name) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '10', language: 'en', format: 'json' });
    const res = await fetchWithRetry(url, { fetchImpl });
    if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
    return (await res.json()).results ?? [];
  }
  return {
    async search(query) {
      let results = await lookup(query);
      // The geocoder only matches place names, so "Douglas, Isle of Man" or
      // "Douglas Isle of Man" finds nothing. Search the first part and use
      // the rest to pick the right one.
      if (!results.length) {
        const [first, ...rest] = query.includes(',') ? query.split(',') : query.split(/\s+/);
        const hint = rest.join(' ').trim().toLowerCase();
        if (hint) {
          const all = await lookup(first.trim());
          results = all.filter((r) => [r.admin1, r.country, HOME[r.country_code]].join(' ').toLowerCase().includes(hint));
        }
      }
      return results
        .filter((r) => r.timezone && isHome(r))
        .slice(0, 8)
        .map((r) => ({
          id: `gn:${r.id}`,
          name: r.name,
          country: homeLabel(r),
          lat: r.latitude,
          lon: r.longitude,
          tz: r.timezone,
        }));
    },
  };
}

// Offline stand-in that only knows the popular places.
export function mockGeocoder() {
  return {
    async search(query) {
      const q = query.toLowerCase();
      return POPULAR.filter((p) => p.name.toLowerCase().includes(q));
    },
  };
}
