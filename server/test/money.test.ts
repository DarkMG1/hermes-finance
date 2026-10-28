import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plaidAmountToCents } from '../src/money.ts';

test('plaid amounts become exact negated cents', () => {
  assert.equal(plaidAmountToCents(19.99), -1999);
  assert.equal(plaidAmountToCents(0.07), -7);
  assert.equal(plaidAmountToCents(1234.56), -123456);
  assert.equal(plaidAmountToCents(-5.49), 549); // refund / inflow
  assert.equal(plaidAmountToCents(0), 0);
});

test('non-finite amounts are rejected', () => {
  assert.throws(() => plaidAmountToCents(Number.NaN));
});

test('Plaid amounts only need to be exact: a huge bank row never fails the sync', () => {
  for (const amount of [1e34, -1e34, Infinity]) assert.throws(() => plaidAmountToCents(amount));
  assert.equal(plaidAmountToCents(10_000_000.01), -1_000_000_001);
  assert.equal(plaidAmountToCents(-10_000_000.01), 1_000_000_001);
});
