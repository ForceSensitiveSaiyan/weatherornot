// Weather providers return a Map of local date ->
//   { tmax (°C), tmin (°C), precip (mm), snow (cm), gust (km/h) }
// covering the last few days and the next few days for a city.
const FIELDS = {
  tmax: 'temperature_2m_max',
  tmin: 'temperature_2m_min',
  precip: 'precipitation_sum',
  snow: 'snowfall_sum',
  gust: 'wind_gusts_10m_max',
};

export function openMeteoProvider({ fetchImpl = fetch } = {}) {
  return {
    name: 'open-meteo',
    async daily(city) {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: city.lat,
        longitude: city.lon,
        daily: Object.values(FIELDS).join(','),
        timezone: city.tz,
        past_days: '3',
        forecast_days: '3',
      });
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${city.id}`);
      const { daily } = await res.json();
      const out = new Map();
      daily.time.forEach((date, i) => {
        out.set(date, Object.fromEntries(
          Object.entries(FIELDS).map(([key, name]) => [key, daily[name]?.[i] ?? null])));
      });
      return out;
    },
  };
}

// Deterministic fake weather for offline development and tests.
export function mockProvider() {
  return {
    name: 'mock',
    async daily(city) {
      const out = new Map();
      const today = new Date();
      for (let i = -3; i <= 2; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() + i);
        const date = d.toISOString().slice(0, 10);
        const r = hash(`${city.id}:${date}`);
        const tmax = Math.round((-5 + (r % 4000) / 100) * 10) / 10;
        const tmin = Math.round((tmax - 4 - ((r >>> 8) % 80) / 10) * 10) / 10;
        const precip = r % 3 === 0 ? ((r >>> 4) % 200) / 10 : 0;
        out.set(date, {
          tmax,
          tmin,
          precip,
          snow: tmax < 2 && precip > 0 ? Math.round(precip * 0.7 * 10) / 10 : 0,
          gust: 10 + ((r >>> 12) % 600) / 10,
        });
      }
      return out;
    },
  };
}

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
