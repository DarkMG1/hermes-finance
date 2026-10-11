import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { getNetWorth, localDay, snapshotBalances } from '../src/networth.ts';
import { syncItem } from '../src/sync/run.ts';
import { AUTH, makeTestDeps, seedAccount, seedItem } from './helpers.ts';
import type { Db } from '../src/db.ts';

const rows = (db: Db) => db.prepare('SELECT account_id, date, balance_cents FROM balance_snapshots ORDER BY account_id, date').all();

test('localDay is the process-local date', () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(localDay(new Date('2026-03-15T03:00:00Z')), '2026-03-14');
    process.env.TZ = 'UTC';
    assert.equal(localDay(new Date('2026-03-15T03:00:00Z')), '2026-03-15');
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('snapshotBalances writes every account with a balance and overwrites the same day', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1', balanceCents: 1000 });
  seedAccount(deps.db, { id: 'a2', type: 'credit', balanceCents: 300, hidden: true });
  seedAccount(deps.db, { id: 'a3' });
  snapshotBalances(deps.db, '2026-03-14');
  deps.db.prepare("UPDATE accounts SET balance_current_cents = 1500 WHERE id = 'a1'").run();
  snapshotBalances(deps.db, '2026-03-14');
  snapshotBalances(deps.db, '2026-03-15');
  assert.deepEqual(rows(deps.db), [
    { account_id: 'a1', date: '2026-03-14', balance_cents: 1500 },
    { account_id: 'a1', date: '2026-03-15', balance_cents: 1500 },
    { account_id: 'a2', date: '2026-03-14', balance_cents: 300 },
    { account_id: 'a2', date: '2026-03-15', balance_cents: 300 },
  ]);
});

test('a successful sync snapshots today; a failed sync writes nothing', async () => {
  const { deps, plaid } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  plaid.queueSync([{ added: [], modified: [], removed: [], nextCursor: 'c1', hasMore: false }]);
  plaid.accounts = [{ accountId: 'pa1', name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 12.34, availableBalance: null }];
  const ok = await syncItem(deps, 'i1');
  assert.equal(ok.result, 'ok');
  const written = rows(deps.db) as { date: string; balance_cents: number }[];
  assert.deepEqual(written.map((r) => [r.date, r.balance_cents]), [[localDay(deps.now()), 1234]]);
  plaid.queueSync([{ added: [], modified: [], removed: [], nextCursor: 'c2', hasMore: false }]);
  plaid.accounts = [{ accountId: 'pa1', name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 20, availableBalance: null }];
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.deepEqual((rows(deps.db) as { date: string; balance_cents: number }[]).map((r) => [r.date, r.balance_cents]), [[localDay(deps.now()), 2000]]);
  deps.db.prepare('DELETE FROM balance_snapshots').run();
  plaid.failNextSync('INSTITUTION_DOWN');
  const failed = await syncItem(deps, 'i1');
  assert.notEqual(failed.result, 'ok');
  assert.deepEqual(rows(deps.db), []);
});

test('an Apple Card import snapshots the card balance', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const csv = 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n'
    + '03/01/2026,03/02/2026,SYNTHETIC SHOP,Synthetic Shop,Shopping,Purchase,9.99,Synthetic Person';
  const res = await app.inject({ method: 'POST', url: '/v1/imports/apple-card', headers: { ...AUTH, 'idempotency-key': 'nw-ac' }, payload: { csv } });
  assert.equal(res.statusCode, 200);
  const accountId = (res.json() as { accountId: string }).accountId;
  assert.deepEqual(rows(deps.db), [{ account_id: accountId, date: localDay(deps.now()), balance_cents: 999 }]);
});

const snap = (db: Db, accountId: string, date: string, cents: number) =>
  db.prepare('INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES (?, ?, ?)').run(accountId, date, cents);

test('history carries balances forward, subtracts credit, and skips hidden accounts', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 5000 });
  seedAccount(deps.db, { id: 'card', type: 'credit', balanceCents: 700 });
  seedAccount(deps.db, { id: 'old', balanceCents: 9999, hidden: true });
  seedAccount(deps.db, { id: 'loan', type: 'loan', balanceCents: 200 });
  snap(deps.db, 'chk', '2026-03-10', 4000);
  snap(deps.db, 'old', '2026-03-10', 9999);
  snap(deps.db, 'card', '2026-03-11', 500);
  snap(deps.db, 'loan', '2026-03-12', 300);
  snap(deps.db, 'chk', '2026-03-13', 5000);
  snap(deps.db, 'loan', '2026-03-13', 200);
  const h = getNetWorth(deps.db, '1m', '2026-03-14');
  assert.deepEqual(h.points, [
    { date: '2026-03-10', netWorthCents: 4000 },
    { date: '2026-03-11', netWorthCents: 3500 },
    { date: '2026-03-12', netWorthCents: 3200 },
    { date: '2026-03-13', netWorthCents: 4300 },
    { date: '2026-03-14', netWorthCents: 4300 },
  ]);
  assert.equal(h.currentCents, 4300);
  assert.equal(h.changeCents, 300);
});

test('the window starts at today minus the range, clamped to the month end and to the first snapshot', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 100 });
  snap(deps.db, 'chk', '2025-12-01', 100);
  snap(deps.db, 'chk', '2026-03-01', 300);
  const month = getNetWorth(deps.db, '1m', '2026-03-31');
  assert.equal(month.points[0]?.date, '2026-02-28');
  assert.equal(month.points.length, 32);
  assert.equal(month.points[0]?.netWorthCents, 100, 'an earlier snapshot carries into the window');
  assert.equal(month.changeCents, 200);
  assert.equal(getNetWorth(deps.db, '3m', '2026-03-31').points[0]?.date, '2025-12-31');
  const all = getNetWorth(deps.db, 'all', '2026-03-31');
  assert.equal(all.points[0]?.date, '2025-12-01');
  assert.equal(getNetWorth(deps.db, '1y', '2026-03-31').points[0]?.date, '2025-12-01', 'clamped to the first snapshot');
});

test('a range longer than the history returns only the days that exist', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 100 });
  snap(deps.db, 'chk', '2026-03-14', 100);
  snap(deps.db, 'chk', '2026-03-15', 150);
  const h = getNetWorth(deps.db, '1y', '2026-03-15');
  assert.deepEqual(h.points.map((p) => p.date), ['2026-03-14', '2026-03-15']);
});

test('no snapshots: no points, the live figure, no change', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 2500 });
  seedAccount(deps.db, { id: 'loan', type: 'loan', balanceCents: 1000 });
  assert.deepEqual(getNetWorth(deps.db, 'all', '2026-03-15'), { points: [], currentCents: 1500, changeCents: 0 });
});

test('GET /v1/net-worth validates the range', async () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 100 });
  snap(deps.db, 'chk', localDay(deps.now()), 100);
  const app = buildApp(deps);
  const ok = await app.inject({ method: 'GET', url: '/v1/net-worth?range=3m', headers: AUTH });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.json().currentCents, 100);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/net-worth?range=2w', headers: AUTH })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/net-worth', headers: AUTH })).statusCode, 400);
});
