// Weather providers return a Map of local date -> { tmax (°C), precip (mm) }
// covering the last few days and the next few days for a city.

export function openMeteoProvider({ fetchImpl = fetch } = {}) {
  return {
    name: 'open-meteo',
    async daily(city) {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: city.lat,
        longitude: city.lon,
        daily: 'temperature_2m_max,precipitation_sum',
        timezone: city.tz,
        past_days: '3',
        forecast_days: '3',
      });
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${city.id}`);
      const { daily } = await res.json();
      const out = new Map();
      daily.time.forEach((date, i) => {
        const tmax = daily.temperature_2m_max[i];
        const precip = daily.precipitation_sum[i];
        if (tmax != null && precip != null) out.set(date, { tmax, precip });
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
        out.set(date, {
          tmax: Math.round((5 + (r % 3000) / 100) * 10) / 10,
          precip: r % 3 === 0 ? ((r >>> 4) % 200) / 10 : 0,
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
