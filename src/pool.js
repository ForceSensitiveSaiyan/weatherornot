// Pari-mutuel settlement: every stake goes into one pot, and the winning
// side splits it in proportion to what they staked. The house takes nothing,
// so nobody can "beat the bookie" just by reading the public forecast.
// If nobody backed the winning side, everyone gets their stake back.
export function settlePool(bets, outcome) {
  const total = bets.reduce((s, b) => s + b.amount, 0);
  const winSum = bets.filter((b) => b.side === outcome).reduce((s, b) => s + b.amount, 0);
  const payouts = new Map();
  for (const b of bets) {
    if (winSum === 0) payouts.set(b.id, b.amount);
    else payouts.set(b.id, b.side === outcome ? Math.floor((b.amount * total) / winSum) : 0);
  }
  return payouts;
}
