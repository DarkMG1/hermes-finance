import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { periodRange } from '../src/ledger.ts';
import { makeTestDeps, AUTH, seedAccount, seedCategory, seedItem, seedSplit, seedTxn } from './helpers.ts';

test('period boundaries', () => {
  assert.deepEqual(periodRange({ period: 'month', date: '2026-12' }), { from: '2026-12-01', toExclusive: '2027-01-01' });
  assert.deepEqual(periodRange({ period: 'month', date: '2026-02' }), { from: '2026-02-01', toExclusive: '2026-03-01' });
  assert.deepEqual(periodRange({ period: 'year', date: '2026' }), { from: '2026-01-01', toExclusive: '2027-01-01' });
});

test('spending: splits, refunds, transfers, income, removed and boundaries', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'food', name: 'Food' });
  seedCategory(db, { id: 'fun', name: 'Fun' });
  seedCategory(db, { id: 'xfer', name: 'Transfer', isTransfer: true });
  seedCategory(db, { id: 'pay', name: 'Paycheck', isIncome: true });
  seedTxn(db, { id: 'dec31', accountId: 'a1', date: '2026-12-31', amountCents: -1000, categoryId: 'food' });
  seedTxn(db, { id: 'jan1', accountId: 'a1', date: '2027-01-01', amountCents: -9999, categoryId: 'food' });
  seedTxn(db, { id: 'refund', accountId: 'a1', date: '2026-12-10', amountCents: 300, categoryId: 'food' });
  seedTxn(db, { id: 'split', accountId: 'a1', date: '2026-12-11', amountCents: -500, categoryId: 'food' });
  seedSplit(db, { id: 's1', transactionId: 'split', amountCents: -200, categoryId: 'food' });
  seedSplit(db, { id: 's2', transactionId: 'split', amountCents: -300, categoryId: 'fun' });
  seedTxn(db, { id: 'move', accountId: 'a1', date: '2026-12-12', amountCents: -5000, categoryId: 'xfer' });
  seedTxn(db, { id: 'salary', accountId: 'a1', date: '2026-12-13', amountCents: 200000, categoryId: 'pay' });
  seedTxn(db, { id: 'gone', accountId: 'a1', date: '2026-12-14', amountCents: -7777, categoryId: 'food', removedAt: 'x' });
  seedTxn(db, { id: 'uncat', accountId: 'a1', date: '2026-12-15', amountCents: -50 });
  const res = await buildApp(deps).inject({ method: 'GET', url: '/v1/spending?period=month&date=2026-12', headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    from: '2026-12-01', toExclusive: '2027-01-01', totalCents: 1250,
    categories: [
      { categoryId: 'food', name: 'Food', spentCents: 900 }, // 1000 - 300 refund + 200 split line
      { categoryId: 'fun', name: 'Fun', spentCents: 300 },
      { categoryId: null, name: 'Uncategorized', spentCents: 50 },
    ],
  });
});

test('spending query is validated', async () => {
  const { deps } = makeTestDeps();
  const res = await buildApp(deps).inject({ method: 'GET', url: '/v1/spending?period=month&date=2026', headers: AUTH });
  assert.equal(res.statusCode, 400);
});

test('home: net worth subtracts credit, ignores hidden, lists recent and reconnects', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok', status: 'login_required' });
  seedAccount(db, { id: 'chk', balanceCents: 100000 });
  seedAccount(db, { id: 'card', type: 'credit', balanceCents: 25000 });
  seedAccount(db, { id: 'old', balanceCents: 999999, hidden: true });
  for (let i = 1; i <= 12; i += 1) seedTxn(db, { id: `t${String(i).padStart(2, '0')}`, accountId: 'chk', date: `2026-03-${String(i).padStart(2, '0')}`, amountCents: -i });
  const home = (await buildApp(deps).inject({ method: 'GET', url: '/v1/home', headers: AUTH })).json();
  assert.equal(home.netWorthCents, 75000);
  assert.equal(home.recent.length, 10);
  assert.equal(home.recent[0].id, 't12');
  assert.deepEqual(home.reconnect, [{ itemId: 'i1', institutionName: 'Synthetic Bank' }]);
});
