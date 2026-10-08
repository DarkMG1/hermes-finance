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
