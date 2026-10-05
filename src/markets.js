// Every kind of bet the game offers. Each one reads a field from the daily
// weather ({ tmax, tmin, precip, snow, gust }), sets a line from tomorrow's
// forecast, and resolves YES or NO against what was actually observed.
export const MARKET_KINDS = {
  temp_over: {
    field: 'tmax',
    unit: '°C',
    label: 'High',
    // Forecast rounded, +0.5, so it's near a coin flip and can't tie.
    line: (f) => Math.round(f.tmax) + 0.5,
    yes: (observed, line) => observed > line,
    question: (city, line) => `Will the high in ${city} be above ${line}°C?`,
  },
  rain: {
    field: 'precip',
    unit: 'mm',
    label: 'Rain',
    line: () => 1,
    yes: (observed, line) => observed >= line,
    question: (city, line) => `Will ${city} get at least ${line} mm of rain?`,
  },
  snow: {
    field: 'snow',
    unit: 'cm',
    label: 'Snow',
    line: () => 0.5,
    // Only worth asking when snow is plausible.
    offered: (f) => f.snow > 0 || f.tmin <= 2,
    yes: (observed, line) => observed >= line,
    question: (city, line) => `Will ${city} get at least ${line} cm of snow?`,
  },
  wind: {
    field: 'gust',
    unit: 'km/h',
    label: 'Gusts',
    line: (f) => Math.round(f.gust / 5) * 5 + 2.5,
    yes: (observed, line) => observed > line,
    question: (city, line) => `Will wind gusts in ${city} top ${line} km/h?`,
  },
};

// The markets to open for one city-day, given its forecast.
export function marketsFor(forecast) {
  return Object.entries(MARKET_KINDS)
    .filter(([, k]) => forecast[k.field] != null && (k.offered?.(forecast) ?? true))
    .map(([kind, k]) => ({ kind, line: k.line(forecast), forecast: forecast[k.field] }));
}

// 1 if YES won, 0 if NO won, null if the observation isn't available yet.
export function resolve(market, observed) {
  const k = MARKET_KINDS[market.kind];
  const value = observed?.[k.field];
  if (value == null) return null;
  return { value, outcome: k.yes(value, market.line) ? 1 : 0 };
}
