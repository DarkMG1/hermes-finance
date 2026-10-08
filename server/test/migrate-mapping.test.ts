import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mappingSkeleton, parseMapping } from '../src/migrate/mapping.ts';
import { MigrationError } from '../src/migrate/import.ts';

test('parseMapping returns actual id -> target and ignores helper fields', () => {
  const text = JSON.stringify({ accounts: { A1: { to: 'h1', name: 'Synthetic Checking' }, A2: { to: 'new' }, A3: { to: 'skip' } }, hermesAccounts: { h1: 'x' } });
  assert.deepEqual(parseMapping(text), { A1: 'h1', A2: 'new', A3: 'skip' });
});

test('parseMapping rejects a missing accounts object and blank targets, naming the account', () => {
  assert.throws(() => parseMapping('{}'), (e: unknown) => e instanceof MigrationError && /"accounts" object/.test(e.message));
  assert.throws(() => parseMapping(JSON.stringify({ accounts: { A1: { to: '' } } })), (e: unknown) => e instanceof MigrationError && /A1/.test(e.message));
  assert.throws(() => parseMapping(JSON.stringify({ accounts: { A1: 'h1' } })), /A1/);
  assert.throws(() => parseMapping('not json'));
});

test('skeleton entries are blank so a forgotten account fails parsing instead of being skipped', () => {
  const skeleton = mappingSkeleton(
    { accounts: [{ id: 'A1', name: 'Synthetic Checking', offbudget: false, closed: true }], categories: [], transactions: [] },
    [{ id: 'h1', name: 'Synthetic Plaid Checking', mask: '0001', type: 'depository' }, { id: 'h2', name: 'Synthetic Card', mask: null, type: 'credit' }],
  );
  assert.deepEqual(skeleton, {
    accounts: { A1: { to: '', name: 'Synthetic Checking', closed: true, offbudget: false } },
    hermesAccounts: { h1: 'Synthetic Plaid Checking ••0001 (depository)', h2: 'Synthetic Card (credit)' },
  });
  assert.throws(() => parseMapping(JSON.stringify(skeleton)), /A1/);
});
