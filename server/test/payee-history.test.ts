import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

// Test clock is 2026-03-15, so the window is 2025-04 … 2026-03.
function setup() {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(db, { id: 'h1', accountId: 'a1', date: '2026-03-10', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Market #123' });
  // split with a roommate: the owner's line counts, the full charge is reported
  seedTxn(db, { id: 'h2', accountId: 'a1', date: '2026-02-05', amountCents: -4000, payee: 'SYNTHETIC*MARKET' });
  seedSplit(db, { id: 'h2-a', transactionId: 'h2', amountCents: -2500, categoryId: 'c-food' });
  seedSplit(db, { id: 'h2-b', transactionId: 'h2', amountCents: -1500, categoryId: null, personId: 'p1' });
  seedTxn(db, { id: 'h3', accountId: 'a1', date: '2026-02-20', amountCents: 300, categoryId: 'c-food', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'h4', accountId: 'a1', date: '2026-01-10', amountCents: -700, personId: 'p1', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'h5', accountId: 'a1', date: '2026-01-11', amountCents: -5000, categoryId: 'c-xfer', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'h6', accountId: 'a1', date: '2026-01-12', amountCents: -800, categoryId: 'c-food', payee: 'Synthetic Market', removedAt: 'x' });
  // the bank changed the amount after the split: the 300 difference counts too
  seedTxn(db, { id: 'h7', accountId: 'a1', date: '2026-01-15', amountCents: -2300, payee: 'Synthetic Market' });
  seedSplit(db, { id: 'h7-a', transactionId: 'h7', amountCents: -1000, categoryId: 'c-food' });
  seedSplit(db, { id: 'h7-b', transactionId: 'h7', amountCents: -1000, categoryId: 'c-food' });
  // renamed payee still matches on the merchant name; outside the chart window but in the list
  seedTxn(db, { id: 'h8', accountId: 'a1', date: '2024-12-01', amountCents: -999, categoryId: 'c-food', payee: 'Synthetic Old', merchantName: 'Synthetic Market' });
  seedTxn(db, { id: 'h9', accountId: 'a1', date: '2026-03-11', amountCents: -400, categoryId: 'c-food', payee: 'Synthetic Other' });
  const app = buildApp(deps);
  return (name: string) => app.inject({ method: 'GET', url: `/v1/payee-history?name=${encodeURIComponent(name)}`, headers: AUTH });
}

test('payee history: owner share, refunds net, drift counts, person/transfer/removed rows excluded', async () => {
  const res = await setup()('synthetic market');
  assert.equal(res.statusCode, 200, res.body);
  const h = res.json();
  assert.equal(h.name, 'synthetic market');
  assert.deepEqual(h.rows.map((r: { transactionId: string; shareCents: number; totalCents: number | null }) => [r.transactionId, r.shareCents, r.totalCents]),
    [['h1', 1000, null], ['h3', -300, null], ['h2', 2500, 4000], ['h7', 2300, 2300], ['h8', 999, null]]);
  assert.equal(h.rows[0].name, 'Synthetic Market #123');
  assert.equal(h.months.length, 12);
  assert.deepEqual(h.months[0], { month: '2025-04', cents: 0 });
  assert.deepEqual(h.months.slice(9), [{ month: '2026-01', cents: 2300 }, { month: '2026-02', cents: 2200 }, { month: '2026-03', cents: 1000 }]);
  assert.deepEqual([h.totalCents, h.averageCents], [5500, 458]);
});

test('payee history: a name with nothing to match is 400 NO_NAME; a missing name is 400', async () => {
  const get = setup();
  const empty = await get('#123456');
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().code, 'NO_NAME');
  assert.equal((await get('Synthetic Nobody')).json().rows.length, 0);
  const app = buildApp(makeTestDeps().deps);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/payee-history', headers: AUTH })).statusCode, 400);
});
