import { fetchWithRetry } from './weather.js';

// Places are identified by their GeoNames id ("gn:<id>"), which is what
// Open-Meteo's geocoding API returns, so a city searched for by two players
// always lands on the same daily game and leaderboard.
//
// WeatherOrNot is launching in the UK: the popular list is UK cities and UK
// search results come first, but anywhere in the world can be played.
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
];

export function openMeteoGeocoder({ fetchImpl = fetch } = {}) {
  return {
    async search(query) {
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
      const res = await fetchWithRetry(url, { fetchImpl });
      if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
      const { results = [] } = await res.json();
      return results
        .filter((r) => r.timezone)
        .sort((a, b) => (b.country_code === 'GB') - (a.country_code === 'GB')) // stable: keeps relevance order
        .map((r) => ({
          id: `gn:${r.id}`,
          name: r.name,
          country: r.country_code === 'GB' ? r.admin1 ?? 'United Kingdom' : [r.admin1, r.country].filter(Boolean).join(', '),
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
