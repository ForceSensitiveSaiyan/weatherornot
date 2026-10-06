import { PRIOR_BIAS } from './questions.js';

// How far a place's observed values have been running above the forecast,
// from its recent history ([{ temp, wind }] of observed minus forecast).
// With little history this leans on the UK-wide prior, moving toward the
// place's own average as days come in.
const PRIOR_WEIGHT = 10; // days of evidence the prior is worth

export function biasFrom(history) {
  const out = {};
  for (const key of ['temp', 'wind']) {
    const values = history.map((h) => h[key]).filter((v) => v != null);
    const sum = values.reduce((a, b) => a + b, 0);
    out[key] = (sum + PRIOR_WEIGHT * PRIOR_BIAS[key]) / (values.length + PRIOR_WEIGHT);
  }
  return out;
}
