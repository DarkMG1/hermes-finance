import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPages, upsertAccounts } from '../src/sync/apply.ts';
import { txn } from './fake-plaid.ts';
import { makeTestDeps, seedCategory, seedItem } from './helpers.ts';
import type { SyncPage } from '../src/plaid/port.ts';

const NOW = '2026-03-15T12:00:00.000Z';
const page = (p: Partial<SyncPage>): SyncPage => ({ added: [], modified: [], removed: [], nextCursor: 'c', hasMore: false, ...p });

function setup() {
  const { deps } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pa1', name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 12.34, availableBalance: null }], NOW);
  const apply = (pages: SyncPage[], cutoverDate: string | null = null) =>
    deps.db.transaction(() => applyPages(deps.db, pages, { cutoverDate, nowIso: NOW }))();
  const row = (sourceId: string) => deps.db.prepare("SELECT * FROM transactions WHERE source = 'plaid' AND source_id = ?").get(sourceId) as Record<string, unknown> | undefined;
  return { deps, apply, row };
}

test('upsertAccounts stores balances in cents and updates on re-run', () => {
  const { deps } = setup();
  const a = deps.db.prepare("SELECT * FROM accounts WHERE plaid_account_id = 'pa1'").get() as Record<string, unknown>;
  assert.equal(a.balance_current_cents, 1234);
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pa1', name: 'Renamed', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 1, availableBalance: 1 }], NOW);
  const b = deps.db.prepare("SELECT * FROM accounts WHERE plaid_account_id = 'pa1'").get() as Record<string, unknown>;
  assert.equal(b.id, a.id);
  assert.equal(b.name, 'Renamed');
  assert.equal(b.balance_current_cents, 100);
});

test('added rows are inserted with negated cents and mapped category', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'coffee', name: 'Coffee' });
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('FOOD_AND_DRINK_COFFEE', 'coffee')").run();
  const counts = apply([page({ added: [txn({ transactionId: 'p1', amount: 4.5 })] })]);
  assert.deepEqual(counts, { added: 1, modified: 0, removed: 0 });
  const r = row('p1');
  assert.equal(r?.amount_cents, -450);
  assert.equal(r?.category_id, 'coffee');
});

test('modified updates bank fields and never owner fields', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  apply([page({ added: [txn({ transactionId: 'p1', amount: 10 })] })]);
  deps.db.prepare("UPDATE transactions SET payee = 'Mine', notes = 'keep', category_id = 'food' WHERE source_id = 'p1'").run();
  apply([page({ modified: [txn({ transactionId: 'p1', amount: 11, merchantName: 'Renamed Shop' })] })]);
  const r = row('p1');
  assert.equal(r?.amount_cents, -1100);
  assert.equal(r?.merchant_name, 'Renamed Shop');
  assert.equal(r?.payee, 'Mine');
  assert.equal(r?.notes, 'keep');
  assert.equal(r?.category_id, 'food');
});

test('removed marks rows removed instead of deleting', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'p1' })] })]);
  const counts = apply([page({ removed: [{ transactionId: 'p1' }] })]);
  assert.equal(counts.removed, 1);
  assert.equal(row('p1')?.removed_at, NOW);
});

test('pending to posted carries owner fields and retires the pending row', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 20 })] })]);
  deps.db.prepare("UPDATE transactions SET category_id = 'food', notes = 'lunch' WHERE source_id = 'pend1'").run();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 21 })], removed: [{ transactionId: 'pend1' }] })]);
  const posted = row('post1');
  assert.equal(posted?.category_id, 'food');
  assert.equal(posted?.notes, 'lunch');
  assert.equal(posted?.pending, 0);
  assert.ok(row('pend1')?.removed_at);
});

test('pending to posted works when the pending removal arrives in a later page', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true })] })]);
  deps.db.prepare("UPDATE transactions SET notes = 'n' WHERE source_id = 'pend1'").run();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1' })], hasMore: true }), page({ removed: [{ transactionId: 'pend1' }] })]);
  assert.equal(row('post1')?.notes, 'n');
  assert.ok(row('pend1')?.removed_at);
});

test('rows dated before the cutover date are skipped', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'old', date: '2026-02-28' }), txn({ transactionId: 'new', date: '2026-03-01' })] })], '2026-03-01');
  assert.equal(row('old'), undefined);
  assert.ok(row('new'));
});

test('re-adding a removed id restores it', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'p1' })] })]);
  apply([page({ removed: [{ transactionId: 'p1' }] })]);
  apply([page({ added: [txn({ transactionId: 'p1' })] })]);
  assert.equal(row('p1')?.removed_at, null);
});

test('unknown account is created before its transactions', () => {
  const { deps, apply, row } = setup();
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pa2', name: 'New Card', mask: '0002', type: 'credit', subtype: 'credit card', currentBalance: 5, availableBalance: null }], NOW);
  apply([page({ added: [txn({ transactionId: 'p2', accountId: 'pa2' })] })]);
  assert.ok(row('p2'));
});

test('a transaction for an account that was never upserted throws', () => {
  const { apply } = setup();
  assert.throws(() => apply([page({ added: [txn({ transactionId: 'p3', accountId: 'pa-missing' })] })]), /unknown plaid account/);
});

test('owner category on pending row is preserved when posted row arrives (A)', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'coffee', name: 'Coffee' });
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('FOOD_AND_DRINK_COFFEE', 'coffee')").run();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 20 })] })]);
  deps.db.prepare("UPDATE transactions SET category_id = 'food' WHERE source_id = 'pend1'").run();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 21 })], removed: [{ transactionId: 'pend1' }] })]);
  const posted = row('post1');
  assert.equal(posted?.category_id, 'food');
});

test('superseded pending rows are not revived (B/C/E)', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true })] })]);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1' })], modified: [txn({ transactionId: 'pend1', pending: true })] })]);
  assert.ok(row('post1'));
  assert.ok(row('pend1')?.removed_at);
});

test('re-applying a page that added pending does not revive it when posted exists (C)', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true })] })]);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1' })] })]);
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true })] })]);
  const p = row('pend1');
  assert.ok(p?.removed_at);
  assert.ok(row('post1'));
});

test('pending listed after posted in same added array still gets superseded (E)', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1' }), txn({ transactionId: 'pend1', pending: true })] })]);
  assert.ok(row('post1'));
  assert.equal(row('pend1'), undefined);
});

test('owner clearing notes on posted row does not refill them on modified (D)', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 20 })] })]);
  deps.db.prepare("UPDATE transactions SET notes = 'from pending' WHERE source_id = 'pend1'").run();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 21 })], removed: [{ transactionId: 'pend1' }] })]);
  const posted = row('post1');
  assert.equal(posted?.notes, 'from pending');
  deps.db.prepare("UPDATE transactions SET notes = NULL WHERE source_id = 'post1'").run();
  apply([page({ modified: [txn({ transactionId: 'post1', amount: 22 })] })]);
  assert.equal(row('post1')?.notes, null);
});

test('a pending row superseded by a removed posted row is not revived when re-sent in modified', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'X', pending: true })] })]);
  apply([page({ added: [txn({ transactionId: 'P', pendingTransactionId: 'X' })], removed: [{ transactionId: 'X' }] })]);
  apply([page({ removed: [{ transactionId: 'P' }] })]);
  apply([page({ modified: [txn({ transactionId: 'X', pending: true })] })]);
  assert.equal(row('X')?.removed_at, NOW);
  assert.equal(row('P')?.removed_at, NOW);
});

test('a pending row superseded by a removed posted row is not revived when re-sent in added', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'X', pending: true })] })]);
  apply([page({ added: [txn({ transactionId: 'P', pendingTransactionId: 'X' })], removed: [{ transactionId: 'X' }] })]);
  apply([page({ removed: [{ transactionId: 'P' }] })]);
  apply([page({ added: [txn({ transactionId: 'X', pending: true })] })]);
  assert.equal(row('X')?.removed_at, NOW);
});

test('a superseded pending row that was never stored is not inserted', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'P', pendingTransactionId: 'X' }), txn({ transactionId: 'X', pending: true })] })]);
  assert.equal(row('X'), undefined);
});
