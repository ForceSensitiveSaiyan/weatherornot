// Places are identified by their GeoNames id ("gn:<id>"), which is what
// Open-Meteo's geocoding API returns, so a city searched for by two players
// always lands on the same daily game and leaderboard.
export const POPULAR = [
  { id: 'gn:2643743', name: 'London', country: 'United Kingdom', lat: 51.5085, lon: -0.1257, tz: 'Europe/London' },
  { id: 'gn:5128581', name: 'New York', country: 'United States', lat: 40.7143, lon: -74.006, tz: 'America/New_York' },
  { id: 'gn:4887398', name: 'Chicago', country: 'United States', lat: 41.85, lon: -87.65, tz: 'America/Chicago' },
  { id: 'gn:5368361', name: 'Los Angeles', country: 'United States', lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles' },
  { id: 'gn:993800', name: 'Johannesburg', country: 'South Africa', lat: -26.2023, lon: 28.0436, tz: 'Africa/Johannesburg' },
  { id: 'gn:3369157', name: 'Cape Town', country: 'South Africa', lat: -33.9258, lon: 18.4232, tz: 'Africa/Johannesburg' },
  { id: 'gn:1850147', name: 'Tokyo', country: 'Japan', lat: 35.6895, lon: 139.6917, tz: 'Asia/Tokyo' },
  { id: 'gn:2147714', name: 'Sydney', country: 'Australia', lat: -33.8678, lon: 151.2073, tz: 'Australia/Sydney' },
];

export function openMeteoGeocoder({ fetchImpl = fetch } = {}) {
  return {
    async search(query) {
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
      const { results = [] } = await res.json();
      return results.filter((r) => r.timezone).map((r) => ({
        id: `gn:${r.id}`,
        name: r.name,
        country: [r.admin1, r.country].filter(Boolean).join(', '),
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
