import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { localDay, snapshotBalances } from '../src/networth.ts';
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
