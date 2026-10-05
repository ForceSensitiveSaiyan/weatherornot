// Cities available for betting. Coordinates feed the weather provider;
// the time zone decides when a city's day starts and ends.
export const CITIES = [
  { id: 'london', name: 'London', lat: 51.5072, lon: -0.1276, tz: 'Europe/London' },
  { id: 'new-york', name: 'New York', lat: 40.7128, lon: -74.006, tz: 'America/New_York' },
  { id: 'chicago', name: 'Chicago', lat: 41.8781, lon: -87.6298, tz: 'America/Chicago' },
  { id: 'los-angeles', name: 'Los Angeles', lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles' },
  { id: 'johannesburg', name: 'Johannesburg', lat: -26.2041, lon: 28.0473, tz: 'Africa/Johannesburg' },
  { id: 'tokyo', name: 'Tokyo', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
  { id: 'sydney', name: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' },
];

export const cityById = new Map(CITIES.map((c) => [c.id, c]));
