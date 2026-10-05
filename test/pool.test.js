import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlePool } from '../src/pool.js';

test('winners split the whole pot in proportion to their stakes', () => {
  const bets = [
    { id: 1, side: 1, amount: 100 },
    { id: 2, side: 1, amount: 300 },
    { id: 3, side: 0, amount: 400 },
  ];
  const p = settlePool(bets, 1);
  assert.deepEqual([...p], [[1, 200], [2, 600], [3, 0]]);
});

test('everyone is refunded when nobody backed the winning side', () => {
  const bets = [{ id: 1, side: 0, amount: 70 }, { id: 2, side: 0, amount: 30 }];
  assert.deepEqual([...settlePool(bets, 1)], [[1, 70], [2, 30]]);
});

test('payouts never exceed the pot', () => {
  const bets = [{ id: 1, side: 1, amount: 1 }, { id: 2, side: 1, amount: 2 }, { id: 3, side: 0, amount: 7 }];
  const total = [...settlePool(bets, 1).values()].reduce((a, b) => a + b, 0);
  assert.ok(total <= 10);
});
