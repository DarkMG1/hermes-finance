import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPages, upsertAccounts } from '../src/sync/apply.ts';
import { txn } from './fake-plaid.ts';
import { makeTestDeps, seedCategory, seedItem, seedSplit } from './helpers.ts';
import type { SyncPage } from '../src/plaid/port.ts';

const NOW = '2026-03-15T12:00:00.000Z';
const page = (p: Partial<SyncPage>): SyncPage => ({ added: [], modified: [], removed: [], nextCursor: 'c', hasMore: false, ...p });

function setup() {
  const { deps } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pa1', name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 12.34, availableBalance: null }], NOW);
  const apply = (pages: SyncPage[], cutoverDate: string | null = null) =>
    deps.db.transaction(() => applyPages(deps.db, pages, { itemId: 'i1', cutoverDate, nowIso: NOW }))();
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

test('an account with its own cutover date uses it instead of the global one', () => {
  const { deps, apply, row } = setup();
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pa2', name: 'Synthetic Card', mask: '0002', type: 'credit', subtype: 'credit card', currentBalance: 5, availableBalance: null }], NOW);
  deps.db.prepare("UPDATE accounts SET cutover_date = '2026-03-01' WHERE plaid_account_id = 'pa2'").run();
  apply([page({ added: [
    txn({ transactionId: 'a-mid', accountId: 'pa1', date: '2026-02-15' }),
    txn({ transactionId: 'b-mid', accountId: 'pa2', date: '2026-02-15' }),
    txn({ transactionId: 'b-late', accountId: 'pa2', date: '2026-03-02' }),
  ] })], '2026-02-01');
  assert.ok(row('a-mid'));
  assert.equal(row('b-mid'), undefined);
  assert.ok(row('b-late'));
});

test('modified and revived rows pick up a mapping learned after they were stored, without replacing a set category', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'coffee', name: 'Coffee' });
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  apply([page({ added: [txn({ transactionId: 'p1' }), txn({ transactionId: 'p2' }), txn({ transactionId: 'p3' })] })]);
  apply([page({ removed: [{ transactionId: 'p2' }] })]);
  deps.db.prepare("UPDATE transactions SET category_id = 'food' WHERE source_id = 'p3'").run();
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('FOOD_AND_DRINK_COFFEE', 'coffee')").run();
  apply([page({ modified: [txn({ transactionId: 'p1' }), txn({ transactionId: 'p3' })], added: [txn({ transactionId: 'p2' })] })]);
  assert.deepEqual(['p1', 'p2', 'p3'].map((id) => row(id)?.category_id), ['coffee', 'coffee', 'food']);
});

test('a category the owner cleared stays cleared through modify and pending to posted', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'coffee', name: 'Coffee' });
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('FOOD_AND_DRINK_COFFEE', 'coffee')").run();
  apply([page({ added: [txn({ transactionId: 'p1' }), txn({ transactionId: 'pend', pending: true })] })]);
  deps.db.prepare("UPDATE transactions SET category_id = NULL, category_owner_set = 1 WHERE source_id IN ('p1', 'pend')").run();
  apply([page({ modified: [txn({ transactionId: 'p1', amount: 9 })], added: [txn({ transactionId: 'posted', pendingTransactionId: 'pend' })] })]);
  assert.equal(row('p1')?.category_id, null);
  assert.equal(row('posted')?.category_id, null);
  assert.equal(row('posted')?.category_owner_set, 1);
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

test('a transaction for an account that was never upserted gets a hidden placeholder account', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'p3', accountId: 'pa-missing' }), txn({ transactionId: 'p4', accountId: 'pa-missing' })] })]);
  const accts = deps.db.prepare("SELECT * FROM accounts WHERE plaid_account_id = 'pa-missing'").all() as Record<string, unknown>[];
  assert.equal(accts.length, 1);
  assert.equal(accts[0]?.item_id, 'i1');
  assert.equal(accts[0]?.name, 'Unknown account');
  assert.equal(accts[0]?.type, 'other');
  assert.equal(accts[0]?.hidden, 1);
  assert.equal(row('p3')?.account_id, accts[0]?.id);
  assert.equal(row('p4')?.account_id, accts[0]?.id);
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

test('a later modified posted row without the pending link keeps it, so the pending row stays retired', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true })] })]);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1' })] })]);
  apply([page({ modified: [txn({ transactionId: 'post1', pendingTransactionId: null })] })]);
  assert.equal(row('post1')?.pending_source_id, 'pend1');
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true })] })]);
  assert.equal(row('pend1')?.removed_at, NOW);
});

test('a placeholder account is unhidden once Plaid lists it; an owner-hidden account stays hidden', () => {
  const { deps, apply } = setup();
  apply([page({ added: [txn({ transactionId: 'p5', accountId: 'pa-late' })] })]);
  deps.db.prepare("UPDATE accounts SET hidden = 1 WHERE plaid_account_id = 'pa1'").run();
  upsertAccounts(deps.db, 'i1', [
    { accountId: 'pa1', name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 1, availableBalance: null },
    { accountId: 'pa-late', name: 'Synthetic Savings', mask: '0003', type: 'depository', subtype: 'savings', currentBalance: 2, availableBalance: null },
  ], NOW);
  const get = (id: string) => deps.db.prepare('SELECT name, hidden FROM accounts WHERE plaid_account_id = ?').get(id);
  assert.deepEqual(get('pa-late'), { name: 'Synthetic Savings', hidden: 0 });
  assert.deepEqual(get('pa1'), { name: 'Synthetic Checking', hidden: 1 });
});

test('investment accounts never get transactions; their balance still syncs', () => {
  const { deps, apply, row } = setup();
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pinv', name: 'Synthetic Roth', mask: '0003', type: 'investment', subtype: 'roth', currentBalance: 100, availableBalance: null }], NOW);
  const counts = apply([page({ added: [txn({ transactionId: 'div1', accountId: 'pinv' })], modified: [txn({ transactionId: 'div2', accountId: 'pinv' })] })]);
  assert.deepEqual(counts, { added: 0, modified: 0, removed: 0 });
  assert.equal(row('div1'), undefined);
  assert.equal(row('div2'), undefined);
});

test('rows parked on a placeholder are retired once Plaid lists the account as an investment one', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'div1', accountId: 'pinv' })] })]);
  assert.equal(row('div1')?.removed_at, null);
  upsertAccounts(deps.db, 'i1', [{ accountId: 'pinv', name: 'Synthetic Roth', mask: '0003', type: 'investment', subtype: 'roth', currentBalance: 100, availableBalance: null }], NOW);
  assert.equal(row('div1')?.removed_at, NOW);
});

test('a split made while pending moves to the posted row; the largest line absorbs a bigger amount', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  seedCategory(deps.db, { id: 'fun', name: 'Fun' });
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 100 })] })]);
  const pendId = row('pend1')?.id as string;
  seedSplit(deps.db, { id: '00-a', transactionId: pendId, amountCents: -4000, categoryId: 'food' });
  seedSplit(deps.db, { id: '01-b', transactionId: pendId, amountCents: -6000, categoryId: 'fun' });
  deps.db.prepare('UPDATE transactions SET category_owner_set = 1 WHERE id = ?').run(pendId);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 125 })], removed: [{ transactionId: 'pend1' }] })]);
  const postId = row('post1')?.id as string;
  const lines = deps.db.prepare('SELECT id, amount_cents AS a, category_id AS c FROM split_lines WHERE transaction_id = ? ORDER BY id').all(postId);
  assert.deepEqual(lines, [{ id: '00-a', a: -4000, c: 'food' }, { id: '01-b', a: -8500, c: 'fun' }]);
  assert.equal(row('post1')?.category_id, null);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM split_lines WHERE transaction_id = ?').get(pendId) as { n: number }).n, 0);
});

test('a smaller amount comes off the largest lines first; one line left ends the split with its category', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  seedCategory(deps.db, { id: 'fun', name: 'Fun' });
  seedCategory(deps.db, { id: 'gas', name: 'Gas' });
  apply([page({ added: [txn({ transactionId: 'p1', amount: 100 })] })]);
  const id = row('p1')?.id as string;
  seedSplit(deps.db, { id: '00-a', transactionId: id, amountCents: -5000, categoryId: 'food' });
  seedSplit(deps.db, { id: '01-b', transactionId: id, amountCents: -3000, categoryId: 'fun' });
  seedSplit(deps.db, { id: '02-c', transactionId: id, amountCents: -2000, categoryId: 'gas' });
  const lines = () => deps.db.prepare('SELECT id, amount_cents AS a FROM split_lines WHERE transaction_id = ? ORDER BY id').all(id);
  apply([page({ modified: [txn({ transactionId: 'p1', amount: 40 })] })]);
  assert.deepEqual(lines(), [{ id: '01-b', a: -2000 }, { id: '02-c', a: -2000 }], 'the 50 line goes, then the 30 line gives 10');
  apply([page({ modified: [txn({ transactionId: 'p1', amount: 15 })] })]);
  assert.deepEqual(lines(), []);
  assert.equal(row('p1')?.category_id, 'gas', 'equal lines give up in entry order, so the later one remains');
});

test('a sign flip ends the split with the largest line category', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  seedCategory(deps.db, { id: 'fun', name: 'Fun' });
  apply([page({ added: [txn({ transactionId: 'p1', amount: 10 })] })]);
  const id = row('p1')?.id as string;
  seedSplit(deps.db, { id: '00-a', transactionId: id, amountCents: -300, categoryId: 'food' });
  seedSplit(deps.db, { id: '01-b', transactionId: id, amountCents: -700, categoryId: 'fun' });
  apply([page({ modified: [txn({ transactionId: 'p1', amount: -10 })] })]);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM split_lines WHERE transaction_id = ?').get(id) as { n: number }).n, 0);
  assert.equal(row('p1')?.category_id, 'fun');
});
