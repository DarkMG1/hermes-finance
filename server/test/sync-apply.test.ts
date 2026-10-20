import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPages, upsertAccounts } from '../src/sync/apply.ts';
import { txn } from './fake-plaid.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedItem, seedSplit, seedPerson, seedTxn } from './helpers.ts';
import { buildApp } from '../src/app.ts';
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
  // p3 is another merchant, so its category isn't remembered for the others
  const p3 = txn({ transactionId: 'p3', merchantName: 'Synthetic Other', name: 'SYNTHETIC OTHER' });
  apply([page({ added: [txn({ transactionId: 'p1' }), txn({ transactionId: 'p2' }), p3] })]);
  apply([page({ removed: [{ transactionId: 'p2' }] })]);
  deps.db.prepare("UPDATE transactions SET category_id = 'food' WHERE source_id = 'p3'").run();
  deps.db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('FOOD_AND_DRINK_COFFEE', 'coffee')").run();
  apply([page({ modified: [txn({ transactionId: 'p1' }), p3], added: [txn({ transactionId: 'p2' })] })]);
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

test('a split made while pending moves to the posted row; a bigger amount grows every line by its share', () => {
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
  assert.deepEqual(lines, [{ id: '00-a', a: -5000, c: 'food' }, { id: '01-b', a: -7500, c: 'fun' }]);
  assert.equal(row('post1')?.category_id, null);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM split_lines WHERE transaction_id = ?').get(pendId) as { n: number }).n, 0);
});

test('a smaller amount shrinks every line by its share; leftover cents go to the largest remainders, and one line left ends the split', () => {
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
  assert.deepEqual(lines(), [{ id: '00-a', a: -2000 }, { id: '01-b', a: -1200 }, { id: '02-c', a: -800 }]);
  apply([page({ modified: [txn({ transactionId: 'p1', amount: 0.02 })] })]);
  assert.deepEqual(lines(), [{ id: '00-a', a: -1 }, { id: '01-b', a: -1 }], 'shares 1, 0.6, 0.4: the spare cent goes to the 0.6 line, and the 0 line goes');
  apply([page({ modified: [txn({ transactionId: 'p1', amount: 0.01 })] })]);
  assert.deepEqual(lines(), []);
  assert.equal(row('p1')?.category_id, 'food', 'equal remainders go in entry order, so the first line keeps the cent');
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

test('a person on a pending row carries to the posted row', () => {
  const { deps, apply, row } = setup();
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 30 })] })]);
  deps.db.prepare("UPDATE transactions SET person_id = 'p1', category_owner_set = 1 WHERE source_id = 'pend1'").run();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 32 })], removed: [{ transactionId: 'pend1' }] })]);
  assert.equal(row('post1')?.person_id, 'p1');
  assert.equal(row('post1')?.category_id, null);
});

test('a pending dinner split with a person posts with a tip: each side pays its share of the difference', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 60 })] })]);
  const pendId = row('pend1')?.id as string;
  seedSplit(deps.db, { id: '00-a', transactionId: pendId, amountCents: -2000, categoryId: 'food' });
  seedSplit(deps.db, { id: '01-b', transactionId: pendId, amountCents: -4000, categoryId: null, personId: 'p1' });
  deps.db.prepare('UPDATE transactions SET category_owner_set = 1 WHERE id = ?').run(pendId);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 72 })], removed: [{ transactionId: 'pend1' }] })]);
  const postId = row('post1')?.id as string;
  assert.deepEqual(deps.db.prepare('SELECT amount_cents AS a, person_id AS p FROM split_lines WHERE transaction_id = ? ORDER BY id').all(postId),
    [{ a: -2400, p: null }, { a: -4800, p: 'p1' }]);
});

test('a split that collapses to one line keeps that line person', () => {
  const { deps, apply, row } = setup();
  seedCategory(deps.db, { id: 'food', name: 'Food' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  apply([page({ added: [txn({ transactionId: 'p1t', amount: 100 })] })]);
  const id = row('p1t')?.id as string;
  seedSplit(deps.db, { id: '00-a', transactionId: id, amountCents: -100, categoryId: 'food' });
  seedSplit(deps.db, { id: '01-b', transactionId: id, amountCents: -9900, categoryId: null, personId: 'p1' });
  apply([page({ modified: [txn({ transactionId: 'p1t', amount: 0.3 })] })]);
  assert.equal(row('p1t')?.person_id, 'p1', 'the food share rounds to 0 and goes, leaving the person line');
  assert.equal(row('p1t')?.category_id, null);
});

test('a split deposit resizes in proportion too', () => {
  const { deps, apply, row } = setup();
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  seedPerson(deps.db, { id: 'p2', name: 'Synthetic Wren' });
  apply([page({ added: [txn({ transactionId: 'v1', amount: -100 })] })]);
  const id = row('v1')?.id as string;
  seedSplit(deps.db, { id: '00-a', transactionId: id, amountCents: 3000, categoryId: null, personId: 'p1' });
  seedSplit(deps.db, { id: '01-b', transactionId: id, amountCents: 7000, categoryId: null, personId: 'p2' });
  apply([page({ modified: [txn({ transactionId: 'v1', amount: -110 })] })]);
  assert.deepEqual(deps.db.prepare('SELECT amount_cents AS a FROM split_lines WHERE transaction_id = ? ORDER BY id').all(id), [{ a: 3300 }, { a: 7700 }]);
});

test('a pending deposit dismissed as not a repayment stays dismissed once it posts', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: -25 })] })]);
  deps.db.prepare("UPDATE transactions SET repayment_dismissed = 1 WHERE source_id = 'pend1'").run();
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: -25 })], removed: [{ transactionId: 'pend1' }] })]);
  assert.equal(row('post1')?.repayment_dismissed, 1);
});

test('applying pages names new Zelle rows', () => {
  const { apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'z1', name: 'Zelle payment from QUILL WREN 12345', merchantName: null, category: 'TRANSFER_IN_DEPOSIT' })] })]);
  assert.equal(row('z1')?.payee, 'Zelle - Quill');
});

test('an owner-set date survives bank updates and moves from pending to posted', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'p1', date: '2026-03-30' }), txn({ transactionId: 'pend1', pending: true, date: '2026-03-30' })] })]);
  deps.db.prepare("UPDATE transactions SET date = '2026-04-01', date_owner_set = 1 WHERE source_id IN ('p1', 'pend1')").run();
  apply([page({ modified: [txn({ transactionId: 'p1', date: '2026-03-31', amount: 11 })] })]);
  assert.equal(row('p1')?.date, '2026-04-01');
  assert.equal(row('p1')?.amount_cents, -1100);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', date: '2026-03-31' })], removed: [{ transactionId: 'pend1' }] })]);
  assert.equal(row('post1')?.date, '2026-04-01');
  assert.equal(row('post1')?.date_owner_set, 1);
  apply([page({ added: [txn({ transactionId: 'p2', date: '2026-03-30' })] })]);
  apply([page({ modified: [txn({ transactionId: 'p2', date: '2026-03-31' })] })]);
  assert.equal(row('p2')?.date, '2026-03-31', 'without an owner date the bank date still wins');
});

test('a receipt on a pending row moves to the posted row', () => {
  const { deps, apply, row } = setup();
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 20 })] })]);
  const pendingId = row('pend1')?.id as string;
  deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, x'FFD8FF', 3, 'x')").run(pendingId);
  deps.db.prepare("INSERT INTO receipt_items (id, transaction_id, position, name, amount_cents, people) VALUES ('ri-1', ?, 0, 'Synthetic Item', 500, '[\"me\"]')").run(pendingId);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 21 })], removed: [{ transactionId: 'pend1' }] })]);
  const postedId = row('post1')?.id as string;
  const r = deps.db.prepare('SELECT transaction_id FROM receipts').all() as { transaction_id: string }[];
  assert.deepEqual(r, [{ transaction_id: postedId }]);
  assert.equal((deps.db.prepare('SELECT transaction_id FROM receipt_items WHERE id = ?').get('ri-1') as { transaction_id: string }).transaction_id, postedId);
});

test('an itemized pending row posts at a new amount: items and receipt move, the split resizes, handEdited turns on', async () => {
  const { deps, apply, row } = setup();
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  apply([page({ added: [txn({ transactionId: 'pend1', pending: true, amount: 20 })] })]);
  const pendId = row('pend1')?.id as string;
  deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, x'FFD8FF', 3, 'x')").run(pendId);
  const app = buildApp(deps);
  const saved = await app.inject({ method: 'PUT', url: `/v1/transactions/${pendId}/receipt/items`, headers: { ...AUTH, 'idempotency-key': 'k1' },
    payload: { items: [{ name: 'Synthetic Soup', amountCents: 1000, people: ['me'] }, { name: 'Synthetic Pie', amountCents: 1000, people: ['p1'] }], taxCents: 0, tipCents: 0, feesCents: 0 } });
  assert.equal(saved.statusCode, 200);
  apply([page({ added: [txn({ transactionId: 'post1', pendingTransactionId: 'pend1', amount: 24 })], removed: [{ transactionId: 'pend1' }] })]);
  const postId = row('post1')?.id as string;
  const lines = deps.db.prepare('SELECT amount_cents AS a, person_id AS p FROM split_lines WHERE transaction_id = ?').all(postId) as { a: number; p: string | null }[];
  assert.deepEqual(lines.map((l) => `${l.p}:${l.a}`).sort(), ['null:-1200', 'p1:-1200']);
  const it = (await app.inject({ method: 'GET', url: `/v1/transactions/${postId}/receipt/items`, headers: AUTH })).json();
  assert.deepEqual(it.items.map((i: { name: string }) => i.name), ['Synthetic Soup', 'Synthetic Pie']);
  assert.equal(it.handEdited, true);
});

test('merchant memory: a new row takes the category of the newest unsplit, untagged row with its name, ahead of the Plaid mapping', () => {
  const { deps, apply, row } = setup();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedPerson(db, { id: 'pp', name: 'Synthetic Quill' });
  for (const id of ['gym', 'coffee', 'other', 'fun']) seedCategory(db, { id, name: id });
  db.prepare("INSERT INTO plaid_category_map (plaid_category, category_id) VALUES ('FOOD_AND_DRINK_COFFEE', 'coffee')").run();
  seedTxn(db, { id: 'm1', accountId: 'a1', date: '2026-01-01', amountCents: -100, categoryId: 'other', merchantName: 'Synthetic Gym' });
  seedTxn(db, { id: 'm2', accountId: 'a1', date: '2026-02-01', amountCents: -100, categoryId: 'gym', payee: 'SYNTHETIC GYM #42', merchantName: 'Synthetic Other' });
  // newer, but split, tagged, removed or uncategorized: none of them teach
  seedTxn(db, { id: 'm3', accountId: 'a1', date: '2026-03-01', amountCents: -100, categoryId: 'fun', payee: 'Synthetic Gym' });
  seedSplit(db, { id: 'm3-a', transactionId: 'm3', amountCents: -100, categoryId: 'fun' });
  seedTxn(db, { id: 'm4', accountId: 'a1', date: '2026-03-02', amountCents: -100, personId: 'pp', payee: 'Synthetic Gym' });
  seedTxn(db, { id: 'm5', accountId: 'a1', date: '2026-03-03', amountCents: -100, categoryId: 'fun', payee: 'Synthetic Gym', removedAt: 'x' });
  seedTxn(db, { id: 'm6', accountId: 'a1', date: '2026-03-04', amountCents: -100, payee: 'Synthetic Gym' });
  apply([page({ added: [
    txn({ transactionId: 'p1', merchantName: 'Synthetic Gym' }),
    txn({ transactionId: 'p2', merchantName: null, name: 'SYNTHETIC GYM 0042' }),
    txn({ transactionId: 'p3', merchantName: 'Synthetic Unknown', name: 'SYNTHETIC GYM' }),
    txn({ transactionId: 'p4', merchantName: 'Synthetic Unknown', name: 'SYNTHETIC NOTHING' }),
    txn({ transactionId: 'pend', merchantName: 'Synthetic Cafe', category: null, pending: true }),
  ] })]);
  assert.deepEqual(['p1', 'p2', 'p3', 'p4', 'pend'].map((id) => row(id)?.category_id), ['gym', 'gym', 'gym', 'coffee', null]);
  // the posted row of an uncategorized pending charge also goes by memory
  seedTxn(db, { id: 'm7', accountId: 'a1', date: '2026-03-05', amountCents: -100, categoryId: 'fun', payee: 'Synthetic Cafe' });
  apply([page({ added: [txn({ transactionId: 'posted', merchantName: 'Synthetic Cafe', pendingTransactionId: 'pend' })] })]);
  assert.equal(row('posted')?.category_id, 'fun');
  // a category already on a row stays
  db.prepare("UPDATE transactions SET category_id = 'other' WHERE source_id = 'p1'").run();
  apply([page({ modified: [txn({ transactionId: 'p1', merchantName: 'Synthetic Gym' })] })]);
  assert.equal(row('p1')?.category_id, 'other');
});
