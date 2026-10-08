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
  assert.deepEqual(run(), { categories: 4, accountsCreated: 1, transactions: 7, splitLines: 2, splitRemainders: 1, orphanCategories: 1, retiredPlaid: 1, offBudgetRows: 0, adjustments: 0 });

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

test('a per-account cutover imports and retires by its own date and is stored on the Hermes account', () => {
  const { db, actualRow } = setup();
  const counts = db.transaction(() => applyImport(db, snapshot, mapping, { cutoverDate: D, cutovers: { 'A-chk': '2026-02-05' }, nowIso: NOW }))();
  assert.equal(counts.transactions, 8);
  assert.equal(counts.retiredPlaid, 2);
  assert.equal(actualRow('a2')?.account_id, 'h-chk', 'a2 is before the account cutover');
  const removedAt = (id: string) => (db.prepare('SELECT removed_at FROM transactions WHERE id = ?').get(id) as { removed_at: string | null }).removed_at;
  assert.equal(removedAt('p-new'), NOW);
  const cut = (id: string) => (db.prepare('SELECT cutover_date FROM accounts WHERE id = ?').get(id) as { cutover_date: string | null }).cutover_date;
  assert.equal(cut('h-chk'), '2026-02-05');
  assert.equal(cut('h-card'), D);
  assert.equal(cut('h-unmapped'), null);
  assert.equal((db.prepare("SELECT cutover_date FROM accounts WHERE name = 'Synthetic A-cash'").get() as { cutover_date: string | null }).cutover_date, null);
  assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cutover_date'").get() as { value: string }).value, D);
});

test('two Actual accounts on one Hermes account with different cutovers are rejected and nothing is written', () => {
  const { db } = setup();
  const m: AccountMapping = { 'A-chk': 'h-chk', 'A-card': 'h-chk', 'A-cash': 'new', 'A-old': 'skip' };
  assert.throws(() => db.transaction(() => applyImport(db, snapshot, m, { cutoverDate: D, cutovers: { 'A-card': '2026-03-01' }, nowIso: NOW }))(),
    (e: unknown) => e instanceof MigrationError && /conflicting cutover dates for Hermes account h-chk/.test(e.message));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'actual'").get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE cutover_date IS NOT NULL').get() as { n: number }).n, 0);
});

function adjustSetup(adjust: boolean) {
  const { deps } = makeTestDeps();
  const db = deps.db;
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  seedAccount(db, { id: 'h-chk', itemId: 'i1', plaidAccountId: 'pa-chk', type: 'depository', balanceCents: 10000 });
  seedAccount(db, { id: 'h-card', itemId: 'i1', plaidAccountId: 'pa-card', type: 'credit', balanceCents: 3000 });
  seedAccount(db, { id: 'h-inv', itemId: 'i1', plaidAccountId: 'pa-inv', type: 'investment', balanceCents: 5000 });
  seedAccount(db, { id: 'h-own', type: 'depository', balanceCents: 7000 }); // no Plaid link: never adjusted
  seedTxn(db, { id: 'p-chk', accountId: 'h-chk', source: 'plaid', sourceId: 'pc', date: '2026-02-03', amountCents: -500 });
  seedTxn(db, { id: 'p-pend', accountId: 'h-chk', source: 'plaid', sourceId: 'pp', date: '2026-02-04', amountCents: -900, pending: true });
  const snap: ActualSnapshot = {
    accounts: [acct('A-chk'), acct('A-card'), acct('A-inv'), acct('A-cash'), acct('A-own')],
    categories: [],
    transactions: [
      tx({ id: 'j1', accountId: 'A-chk', date: '2026-01-05', amountCents: 12845 }),
      tx({ id: 'j2', accountId: 'A-card', date: '2026-01-06', amountCents: -1000 }),
      tx({ id: 'j3', accountId: 'A-inv', date: '2026-01-07', amountCents: 100 }),
      tx({ id: 'j4', accountId: 'A-cash', date: '2026-01-08', amountCents: 300 }),
      tx({ id: 'j5', accountId: 'A-own', date: '2026-01-09', amountCents: 100 }),
    ],
  };
  const m: AccountMapping = { 'A-chk': 'h-chk', 'A-card': 'h-card', 'A-inv': 'h-inv', 'A-cash': 'new', 'A-own': 'h-own' };
  const counts = db.transaction(() => applyImport(db, snap, m, { cutoverDate: D, cutovers: { 'A-card': '2026-02-10' }, adjust, nowIso: NOW }))();
  const adjustments = db.prepare("SELECT * FROM transactions WHERE source_id LIKE 'adjustment:%' ORDER BY source_id").all() as Record<string, unknown>[];
  const ledger = (id: string) => (db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE account_id = ? AND source IN ('actual', 'plaid') AND removed_at IS NULL AND pending = 0").get(id) as { s: number }).s;
  return { db, counts, adjustments, ledger };
}

test('adjust writes one Transfers-category adjustment per reconcilable gap, dated the day before the account cutover', () => {
  const { db, counts, adjustments, ledger } = adjustSetup(true);
  assert.equal(counts.adjustments, 2);
  const transfers = (db.prepare("SELECT id FROM categories WHERE name = 'Transfers' AND is_transfer = 1").get() as { id: string }).id;
  const pick = (r: Record<string, unknown>) => ({ account: r.account_id, source: r.source, sourceId: r.source_id, date: r.date, amount: r.amount_cents,
    desc: r.bank_description, payee: r.payee, notes: r.notes, category: r.category_id, pending: r.pending });
  const common = { source: 'actual', desc: 'Balance adjustment (migration)', payee: 'Balance adjustment (migration)',
    notes: 'Difference between Actual history and the bank balance at migration', category: transfers, pending: 0 };
  assert.deepEqual(adjustments.map(pick), [
    { account: 'h-card', sourceId: 'adjustment:h-card', date: '2026-02-09', amount: -2000, ...common },
    { account: 'h-chk', sourceId: 'adjustment:h-chk', date: '2026-01-31', amount: -2345, ...common },
  ]);
  assert.equal(ledger('h-chk'), 10000);
  assert.equal(ledger('h-card'), -3000);
});

test('adjust=false writes no adjustments', () => {
  const { counts, adjustments } = adjustSetup(false);
  assert.equal(counts.adjustments, 0);
  assert.equal(adjustments.length, 0);
});

test('adjustment rows are excluded from spending', () => {
  const withAdj = adjustSetup(true).db;
  const without = adjustSetup(false).db;
  for (const date of ['2026-01', '2026-02']) {
    const q = { period: 'month', date } as const;
    assert.equal(getSpending(withAdj, q).totalCents, getSpending(without, q).totalCents);
  }
});
