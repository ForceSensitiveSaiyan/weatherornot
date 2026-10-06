// Wording shared by the page and the server's link previews, so a WhatsApp
// preview and the app always say the same thing.

const round1 = (x) => Math.round(x * 10) / 10;
export const NUMBERS = ['none', 'one', 'two', 'three'];

// What the weather did, in the terse voice of a station report:
// "dry, 13.7°C, gusts 40 mph". Takes [{ key, observed }].
export function weatherLine(questions) {
  const get = (key) => questions.find((q) => q.key === key)?.observed;
  const parts = [];
  const rain = get('rain');
  if (rain != null) parts.push(rain < 0.2 ? 'dry' : rain < 1 ? `a few spots (${round1(rain)} mm)` : `${round1(rain)} mm of rain`);
  const temp = get('temp');
  if (temp != null) parts.push(`${round1(temp)}°C`);
  const wind = get('wind');
  if (wind != null) parts.push(`gusts ${Math.round(wind)} mph`);
  return parts.join(', ');
}

// Where the reading came from: "Ronaldsway Airport", or the model's estimate.
export const sourceName = (source) => (source?.type === 'station' ? source.name : 'Forecast model estimate');

// "Mon 5 Oct"
// (built by hand: browsers and Node disagree about the comma).
export function shortDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const part = (opts) => d.toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
  return `${part({ weekday: 'short' })} ${d.getUTCDate()} ${part({ month: 'short' })}`;
}

// How you did against the forecast, in one line.
export function scoreLine(got, of, forecast) {
  const you = got === 0 ? 'None right' : got === of ? (of === 3 ? 'All three right' : of === 2 ? 'Both right' : 'Right') : `${cap(NUMBERS[got])} from ${NUMBERS[of]}`;
  if (forecast == null) return `${you}.`;
  if (got > forecast) return `${you}. You beat the forecast, which got ${NUMBERS[forecast]}.`;
  if (got === forecast) return `${you}, same as the forecast.`;
  return `${you}. The forecast got ${forecast === of ? `all ${NUMBERS[of]}` : NUMBERS[forecast]}.`;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
