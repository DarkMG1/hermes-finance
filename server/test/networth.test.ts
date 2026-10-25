import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { getNetWorth, localDay, snapshotBalances } from '../src/networth.ts';
import { addDays } from '../src/days.ts';
import { syncItem } from '../src/sync/run.ts';
import { AUTH, makeTestDeps, seedAccount, seedItem, seedTxn } from './helpers.ts';
import type { Db } from '../src/db.ts';

const rows = (db: Db) => db.prepare('SELECT account_id, date, balance_cents FROM balance_snapshots ORDER BY account_id, date').all();

test('estimated totals exclude unpriced positions, retain sale cash, and agree across filters', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 45000 });
  seedAccount(db, { id: 'chk', balanceCents: 1000 });
  db.prepare(`INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES
    ('fund', 'Synthetic A Fund', 'SYNA', 'etf', 0, 's'),
    ('option', 'Synthetic Option', 'SYNX', 'derivative', 0, 's'),
    ('cash', 'Synthetic Dollar', NULL, 'cash', 1, 's')`).run();
  db.prepare("INSERT INTO holding_syncs VALUES ('inv', '2026-03-15')").run();
  db.prepare(`INSERT INTO holding_snapshots VALUES
    ('inv', 'fund', '2026-03-15', 3, 30000), ('inv', 'cash', '2026-03-15', 13000, 13000)`).run();
  db.prepare("INSERT INTO security_prices (ticker, date, close_cents) VALUES ('SYNA', '2026-03-09', 10000), ('SYNX', '2026-03-09', 99999)").run();
  db.prepare(`INSERT INTO investment_transactions VALUES
    ('buy', 'inv', 'option', '2026-03-10', 'buy', 'buy', 2, 14000, 7000, 's'),
    ('sell', 'inv', 'option', '2026-03-13', 'sell', 'sell', -2, -8000, 4000, 's')`).run();
  db.prepare("INSERT INTO balance_snapshots VALUES ('inv', '2026-03-15', 45000), ('chk', '2026-03-15', 1000)").run();
  const inv = getNetWorth(db, 'all', '2026-03-15', { type: 'investment' });
  assert.deepEqual(inv.points.map((p) => p.netWorthCents), [35000, 35000, 35000, 43000, 43000, 45000]);
  assert.deepEqual(inv.excluded, { through: '2026-03-12', positions: 1 });
  assert.equal(inv.currentCents, 45000);
  assert.equal(inv.changeCents, 10000);
  const all = getNetWorth(db, 'all', '2026-03-15');
  assert.deepEqual(all.points.map((p) => p.netWorthCents), [36000, 36000, 36000, 44000, 44000, 46000]);
  assert.deepEqual(all.excluded, inv.excluded);
  assert.deepEqual(getNetWorth(db, 'all', '2026-03-15', { accountIds: ['inv'] }), inv);
  assert.equal('excluded' in getNetWorth(db, 'all', '2026-03-15', { accountIds: ['chk'] }), false);
  assert.equal('excluded' in getNetWorth(db, '1m', '2026-04-13', { type: 'investment' }), false);
  const app = buildApp(deps);
  const history = await app.inject({ method: 'GET', url: '/v1/investments/history?range=all', headers: AUTH });
  assert.deepEqual(history.json(), inv);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/net-worth?range=all', headers: AUTH })).json(), all);
  await app.close();
});

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

test('history advances calendar days across years below 100', () => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'a1', balanceCents: 100 });
  snap(db, 'a1', '0099-12-31', 100);
  assert.equal(addDays('0099-12-31', 1), '0100-01-01');
  assert.deepEqual(getNetWorth(db, 'all', '0100-01-02').points.map((p) => p.date), ['0099-12-31', '0100-01-01', '0100-01-02']);
});

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
    { date: '2026-03-10', netWorthCents: 3200 },
    { date: '2026-03-11', netWorthCents: 3200 },
    { date: '2026-03-12', netWorthCents: 3200 },
    { date: '2026-03-13', netWorthCents: 4300 },
    { date: '2026-03-14', netWorthCents: 4300 },
  ]);
  assert.equal(h.currentCents, 4300);
  assert.equal(h.changeCents, 1100);
  assert.equal(h.estimatedThrough, '2026-03-11');
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
  assert.equal(month.estimatedThrough, null);
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
  assert.deepEqual(getNetWorth(deps.db, 'all', '2026-03-15'), { points: [], currentCents: 1500, changeCents: 0, estimatedThrough: null });
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

test('rebuilds checking, credit and loan from transactions; investments stay flat', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 10000 });
  seedAccount(deps.db, { id: 'card', type: 'credit', balanceCents: 1500 });
  seedAccount(deps.db, { id: 'loan', type: 'loan', balanceCents: 20000 });
  seedAccount(deps.db, { id: 'inv', type: 'investment', balanceCents: 50000 });
  snap(deps.db, 'chk', '2026-03-14', 10000);
  snap(deps.db, 'card', '2026-03-14', 1500);
  snap(deps.db, 'loan', '2026-03-14', 20000);
  snap(deps.db, 'inv', '2026-03-14', 50000);
  seedTxn(deps.db, { id: 't0', accountId: 'chk', date: '2026-03-10', amountCents: 100 });
  seedTxn(deps.db, { id: 't1', accountId: 'chk', date: '2026-03-12', amountCents: 5000 });
  seedTxn(deps.db, { id: 't2', accountId: 'chk', date: '2026-03-13', amountCents: -2000 });
  seedTxn(deps.db, { id: 't3', accountId: 'chk', date: '2026-03-14', amountCents: -500 });
  seedTxn(deps.db, { id: 't4', accountId: 'chk', date: '2026-03-13', amountCents: -9999, pending: true });
  seedTxn(deps.db, { id: 't5', accountId: 'chk', date: '2026-03-13', amountCents: -7777, removedAt: '2026-03-14T00:00:00Z' });
  seedTxn(deps.db, { id: 't6', accountId: 'card', date: '2026-03-13', amountCents: -1000 });
  seedTxn(deps.db, { id: 't7', accountId: 'card', date: '2026-03-14', amountCents: 500 });
  seedTxn(deps.db, { id: 't8', accountId: 'loan', date: '2026-03-12', amountCents: 1000 });
  seedTxn(deps.db, { id: 't9', accountId: 'inv', date: '2026-03-12', amountCents: -3000 });
  // 03-10..03-14: checking 7500 / 7500 / 12500 / 10500 / 10000; card -1000 / -1000 / -1000 / -2000 / -1500;
  // loan -21000 / -21000 / -20000 / -20000 / -20000; investment 50000
  const expected = [
    { date: '2026-03-10', netWorthCents: 35500 },
    { date: '2026-03-11', netWorthCents: 35500 },
    { date: '2026-03-12', netWorthCents: 41500 },
    { date: '2026-03-13', netWorthCents: 38500 },
    { date: '2026-03-14', netWorthCents: 38500 },
    { date: '2026-03-15', netWorthCents: 38500 },
  ];
  const all = getNetWorth(deps.db, 'all', '2026-03-15');
  assert.deepEqual(all.points, expected);
  assert.equal(all.currentCents, 38500);
  assert.equal(all.changeCents, 3000);
  assert.equal(all.estimatedThrough, '2026-03-13');
  assert.deepEqual(getNetWorth(deps.db, '1y', '2026-03-15').points, expected, '1y reaches back before the first snapshot');
});

test('an account linked later is estimated before its own first snapshot', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 1000 });
  seedAccount(deps.db, { id: 'new', balanceCents: 3000 });
  snap(deps.db, 'chk', '2026-03-10', 1000);
  snap(deps.db, 'chk', '2026-03-15', 1000);
  snap(deps.db, 'new', '2026-03-14', 3000);
  seedTxn(deps.db, { id: 'open', accountId: 'new', date: '2026-03-12', amountCents: 3000 });
  const h = getNetWorth(deps.db, 'all', '2026-03-15');
  assert.deepEqual(h.points.map((p) => p.netWorthCents), [1000, 1000, 4000, 4000, 4000, 4000], 'the opening deposit means 0 before it');
  assert.equal(h.points[0]?.date, '2026-03-10');
  assert.equal(h.estimatedThrough, '2026-03-13');
});

test('real snapshots win and later transactions are ignored', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 1200 });
  snap(deps.db, 'chk', '2026-03-12', 1000);
  snap(deps.db, 'chk', '2026-03-14', 1200);
  seedTxn(deps.db, { id: 'late', accountId: 'chk', date: '2026-03-13', amountCents: 5000 });
  const h = getNetWorth(deps.db, 'all', '2026-03-15');
  assert.deepEqual(h.points, [
    { date: '2026-03-12', netWorthCents: 1000 },
    { date: '2026-03-13', netWorthCents: 1000 },
    { date: '2026-03-14', netWorthCents: 1200 },
    { date: '2026-03-15', netWorthCents: 1200 },
  ]);
  assert.equal(h.estimatedThrough, null);
});

test('hidden accounts and flat types never move the start', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 100 });
  seedAccount(deps.db, { id: 'old', balanceCents: 900, hidden: true });
  seedAccount(deps.db, { id: 'inv', type: 'investment', balanceCents: 500 });
  seedAccount(deps.db, { id: 'nosnap', balanceCents: 700 });
  snap(deps.db, 'chk', '2026-03-14', 100);
  snap(deps.db, 'old', '2026-03-14', 900);
  snap(deps.db, 'inv', '2026-03-14', 500);
  seedTxn(deps.db, { id: 'h1', accountId: 'old', date: '2026-02-01', amountCents: 900 });
  seedTxn(deps.db, { id: 'i1', accountId: 'inv', date: '2026-02-02', amountCents: 500 });
  seedTxn(deps.db, { id: 'n1', accountId: 'nosnap', date: '2026-02-03', amountCents: 700 });
  const h = getNetWorth(deps.db, 'all', '2026-03-15');
  assert.deepEqual(h.points, [{ date: '2026-03-14', netWorthCents: 600 }, { date: '2026-03-15', netWorthCents: 600 }]);
});

test('a window that starts inside the estimate carries the moves before it', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 10000 });
  snap(deps.db, 'chk', '2026-03-14', 10000);
  seedTxn(deps.db, { id: 'feb', accountId: 'chk', date: '2026-02-01', amountCents: 4000 });
  seedTxn(deps.db, { id: 'mar', accountId: 'chk', date: '2026-03-01', amountCents: -1000 });
  // 7000 before Feb 1, 11000 from Feb 1, 10000 from Mar 1
  const h = getNetWorth(deps.db, '1m', '2026-03-15');
  assert.deepEqual(h.points[0], { date: '2026-02-15', netWorthCents: 11000 });
  assert.equal(h.points.find((p) => p.date === '2026-03-01')?.netWorthCents, 10000);
  assert.equal(h.points.length, 29);
  assert.equal(h.currentCents, 10000);
  assert.equal(h.changeCents, -1000);
  assert.equal(h.estimatedThrough, '2026-03-13');
});

test('a snapshot dated after today is ignored, with its transactions', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 1000 });
  seedAccount(deps.db, { id: 'new', balanceCents: 3000 });
  snap(deps.db, 'chk', '2026-03-10', 1000);
  snap(deps.db, 'new', '2026-03-16', 3000);
  seedTxn(deps.db, { id: 'open', accountId: 'new', date: '2026-03-12', amountCents: 3000 });
  const h = getNetWorth(deps.db, 'all', '2026-03-15');
  assert.deepEqual(h.points.map((p) => p.netWorthCents), [1000, 1000, 1000, 1000, 1000, 1000]);
  assert.equal(h.points[0]?.date, '2026-03-10');
  assert.equal(h.currentCents, 1000);
  assert.equal(h.changeCents, 0);
  assert.equal(h.estimatedThrough, null);
});

test('net worth probes a missing investment estimate once per account', (t) => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 100 });
  for (const day of ['2026-03-01', '2026-03-02', '2026-03-03']) snap(db, 'inv', day, 100);
  const prepare = db.prepare.bind(db);
  let probes = 0;
  t.mock.method(db, 'prepare', (sql: string) => {
    if (sql.includes('MIN(date) AS d FROM holding_syncs')) probes += 1;
    return prepare(sql);
  });
  assert.equal(getNetWorth(db, '1m', '2026-03-15').currentCents, 100);
  assert.equal(probes, 1);
});
