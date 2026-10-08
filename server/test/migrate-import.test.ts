import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyImport, MigrationError, type AccountMapping } from '../src/migrate/import.ts';
import type { ActualSnapshot, ActualTxn } from '../src/migrate/actual.ts';
import { getSpending } from '../src/ledger.ts';
import { makeTestDeps, seedAccount, seedCategory, seedItem, seedTxn } from './helpers.ts';

const D = '2026-02-01';
const NOW = '2026-03-15T12:00:00.000Z';

const acct = (id: string, extra: Partial<ActualSnapshot['accounts'][number]> = {}) => ({ id, name: `Synthetic ${id}`, offbudget: false, closed: false, ...extra });
const tx = (p: Partial<ActualTxn> & Pick<ActualTxn, 'id' | 'accountId' | 'date' | 'amountCents'>): ActualTxn =>
  ({ categoryId: null, payee: null, importedPayee: null, notes: null, isTransfer: false, lines: [], ...p });

const snapshot: ActualSnapshot = {
  accounts: [acct('A-chk'), acct('A-card'), acct('A-cash'), acct('A-old', { closed: true })],
  categories: [
    { id: 'C-a', name: 'Synthetic Cat A', groupName: 'Synthetic Group 1', isIncome: false, hidden: false },
    { id: 'C-a2', name: 'Synthetic Cat A', groupName: 'Synthetic Group 2', isIncome: false, hidden: true },
    { id: 'C-pay', name: 'Synthetic Pay', groupName: 'Synthetic Income', isIncome: true, hidden: false },
  ],
  transactions: [
    tx({ id: 'a1', accountId: 'A-chk', date: '2026-01-05', amountCents: -2500, categoryId: 'C-a', payee: 'Synthetic Store', importedPayee: 'SYNTH 001', notes: 'note one' }),
    tx({ id: 'a2', accountId: 'A-chk', date: '2026-02-03', amountCents: -700, categoryId: 'C-a' }), // on/after D: Plaid owns it
    tx({ id: 'a3', accountId: 'A-chk', date: '2026-01-06', amountCents: -3000, lines: [
      { amountCents: -1000, categoryId: 'C-a', notes: 'line one', isTransfer: false },
      { amountCents: -1500, categoryId: 'C-a2', notes: null, isTransfer: false },
    ] }), // lines sum to -2500: needs a -500 remainder
    tx({ id: 'a4', accountId: 'A-chk', date: '2026-01-07', amountCents: -10000, isTransfer: true }),
    tx({ id: 'a5', accountId: 'A-card', date: '2026-01-08', amountCents: 10000, isTransfer: true }),
    tx({ id: 'a6', accountId: 'A-cash', date: '2026-03-01', amountCents: -400, categoryId: 'C-a' }), // new account: imported despite D
    tx({ id: 'a7', accountId: 'A-cash', date: '2026-01-02', amountCents: 5000, categoryId: 'C-pay' }),
    tx({ id: 'a8', accountId: 'A-old', date: '2025-06-01', amountCents: -100 }), // skipped account
    tx({ id: 'a9', accountId: 'A-chk', date: '2026-01-09', amountCents: -50, categoryId: 'C-gone' }), // deleted category
  ],
};
const mapping: AccountMapping = { 'A-chk': 'h-chk', 'A-card': 'h-card', 'A-cash': 'new', 'A-old': 'skip' };

function setup() {
  const { deps } = makeTestDeps();
  const db = deps.db;
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  seedAccount(db, { id: 'h-chk', itemId: 'i1', plaidAccountId: 'pa-chk', type: 'depository', balanceCents: 0 });
  seedAccount(db, { id: 'h-card', itemId: 'i1', plaidAccountId: 'pa-card', type: 'credit', balanceCents: 0 });
  seedAccount(db, { id: 'h-unmapped', itemId: 'i1', plaidAccountId: 'pa-x', type: 'depository', balanceCents: 0 });
  seedTxn(db, { id: 'p-old', accountId: 'h-chk', source: 'plaid', sourceId: 'po', date: '2026-01-05', amountCents: -2500 });
  seedTxn(db, { id: 'p-new', accountId: 'h-chk', source: 'plaid', sourceId: 'pn', date: '2026-02-03', amountCents: -700 });
  seedTxn(db, { id: 'p-unmapped-old', accountId: 'h-unmapped', source: 'plaid', sourceId: 'pu', date: '2026-01-05', amountCents: -100 });
  const run = (m: AccountMapping = mapping) => db.transaction(() => applyImport(db, snapshot, m, { cutoverDate: D, nowIso: NOW }))();
  const actualRow = (sourceId: string) => db.prepare("SELECT * FROM transactions WHERE source = 'actual' AND source_id = ?").get(sourceId) as Record<string, unknown> | undefined;
  const catId = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string } | undefined)?.id;
  return { db, run, actualRow, catId };
}

test('imports history before D, splits, transfers and new accounts, and retires overlapping Plaid rows', () => {
  const { db, run, actualRow, catId } = setup();
  assert.deepEqual(run(), { categories: 4, accountsCreated: 1, transactions: 7, splitLines: 2, splitRemainders: 1, orphanCategories: 1, retiredPlaid: 1, offBudgetRows: 0 });

  const a1 = actualRow('a1');
  assert.equal(a1?.account_id, 'h-chk');
  assert.equal(a1?.amount_cents, -2500);
  assert.equal(a1?.bank_description, 'SYNTH 001');
  assert.equal(a1?.payee, 'Synthetic Store');
  assert.equal(a1?.notes, 'note one');
  assert.equal(a1?.category_id, catId('Synthetic Cat A'));
  assert.equal(actualRow('a2'), undefined, 'rows on/after D in a mapped account belong to Plaid');
  assert.equal(actualRow('a8'), undefined, 'skipped account');
  assert.equal(actualRow('a9')?.category_id, null);

  const a3 = actualRow('a3');
  assert.equal(a3?.category_id, null);
  const lines = db.prepare('SELECT amount_cents, category_id, notes FROM split_lines WHERE transaction_id = ? ORDER BY amount_cents').all(String(a3?.id)) as
    { amount_cents: number; category_id: string | null; notes: string | null }[];
  assert.deepEqual(lines.map((l) => l.amount_cents), [-1500, -1000, -500]);
  assert.equal(lines.reduce((s, l) => s + l.amount_cents, 0), -3000, 'lines sum to the parent');
  assert.equal(lines[0]?.category_id, catId('Synthetic Cat A (Synthetic Group 2)'));
  assert.equal(lines[2]?.category_id, null, 'remainder is uncategorized');

  const transfers = db.prepare("SELECT id, is_transfer FROM categories WHERE name = 'Transfers'").get() as { id: string; is_transfer: number };
  assert.equal(transfers.is_transfer, 1);
  assert.equal(actualRow('a4')?.category_id, transfers.id);
  assert.equal(actualRow('a5')?.category_id, transfers.id);
  assert.equal((db.prepare("SELECT hidden FROM categories WHERE name = 'Synthetic Cat A (Synthetic Group 2)'").get() as { hidden: number }).hidden, 1);
  assert.equal((db.prepare("SELECT is_income FROM categories WHERE name = 'Synthetic Pay'").get() as { is_income: number }).is_income, 1);

  const cash = db.prepare("SELECT * FROM accounts WHERE name = 'Synthetic A-cash'").get() as Record<string, unknown>;
  assert.equal(cash.type, 'other');
  assert.equal(cash.item_id, null);
  assert.equal(cash.plaid_account_id, null);
  assert.equal(cash.balance_current_cents, 4600);
  assert.equal(cash.hidden, 0);
  assert.equal(actualRow('a6')?.account_id, cash.id);

  const removedAt = (id: string) => (db.prepare('SELECT removed_at FROM transactions WHERE id = ?').get(id) as { removed_at: string | null }).removed_at;
  assert.equal(removedAt('p-old'), NOW);
  assert.equal(removedAt('p-new'), null);
  assert.equal(removedAt('p-unmapped-old'), null, 'Plaid accounts without Actual history keep their Plaid history');
  assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cutover_date'").get() as { value: string }).value, D);
});

test('reuses an existing Hermes category with the same name', () => {
  const { db, run, actualRow } = setup();
  seedCategory(db, { id: 'existing', name: 'Synthetic Cat A' });
  assert.equal(run().categories, 3);
  assert.equal(actualRow('a1')?.category_id, 'existing');
});

test('reuses an existing Transfers category and flags it as a transfer category', () => {
  const { db, run, actualRow } = setup();
  seedCategory(db, { id: 'tr', name: 'Transfers' });
  run();
  assert.equal((db.prepare("SELECT is_transfer FROM categories WHERE id = 'tr'").get() as { is_transfer: number }).is_transfer, 1);
  assert.equal(actualRow('a4')?.category_id, 'tr');
});

test('rejects an incomplete or wrong mapping, listing every problem, and writes nothing', () => {
  const { db, run } = setup();
  const bad: AccountMapping = { 'A-chk': 'h-chk', 'A-card': 'h-nope', 'A-cash': 'new', 'A-typo': 'skip' };
  assert.throws(() => run(bad), (e: unknown) => e instanceof MigrationError
    && /unmapped Actual account A-old/.test(e.message)
    && /unknown Actual account A-typo/.test(e.message)
    && /h-nope is not a Hermes account/.test(e.message));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'actual'").get() as { n: number }).n, 0);
});

test('uncategorized rows in an off-budget account get a hidden Off budget category that spending excludes', () => {
  const { db, actualRow, catId } = setup();
  const off: ActualSnapshot = {
    accounts: [acct('A-loan', { offbudget: true })],
    categories: [],
    transactions: [
      tx({ id: 'o1', accountId: 'A-loan', date: '2026-01-03', amountCents: -500000 }),
      tx({ id: 'o2', accountId: 'A-loan', date: '2026-01-04', amountCents: 2000, isTransfer: true }),
    ],
  };
  const jan = { period: 'month', date: '2026-01' } as const;
  const before = getSpending(db, jan).totalCents;
  const counts = db.transaction(() => applyImport(db, off, { 'A-loan': 'new' }, { cutoverDate: D, nowIso: NOW }))();
  assert.equal(counts.offBudgetRows, 1);
  const cat = db.prepare("SELECT id, group_name, is_transfer, hidden FROM categories WHERE name = 'Off budget'").get() as Record<string, unknown>;
  assert.deepEqual({ group: cat.group_name, isTransfer: cat.is_transfer, hidden: cat.hidden }, { group: 'Off budget', isTransfer: 1, hidden: 1 });
  assert.equal(actualRow('o1')?.category_id, cat.id);
  assert.equal(actualRow('o2')?.category_id, catId('Transfers'));
  assert.equal(getSpending(db, jan).totalCents, before);
});
