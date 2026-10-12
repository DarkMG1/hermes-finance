import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../src/db.ts';
import { NEEDS_RECONCILE } from '../src/reconcile.ts';
import { getTransaction } from '../src/ledger.ts';
import { makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

function seedAll(db: Db): void {
  seedAccount(db, { id: 'chk', type: 'depository' });
  seedAccount(db, { id: 'brk', type: 'investment' });
  seedCategory(db, { id: 'food', name: 'Synthetic Food' });
  seedCategory(db, { id: 'xfer', name: 'Synthetic Transfer', isTransfer: true });
  seedCategory(db, { id: 'pay', name: 'Synthetic Pay', isIncome: true });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  const d = '2026-08-10';
  seedTxn(db, { id: 'spend', accountId: 'chk', date: d, amountCents: -500, categoryId: 'food' });
  seedTxn(db, { id: 'refund', accountId: 'chk', date: d, amountCents: 500, categoryId: 'food' });
  seedTxn(db, { id: 'xfer-cat', accountId: 'chk', date: d, amountCents: -500, categoryId: 'xfer' });
  seedTxn(db, { id: 'income-cat', accountId: 'chk', date: d, amountCents: -500, categoryId: 'pay' });
  seedTxn(db, { id: 'uncat', accountId: 'chk', date: d, amountCents: -500 });
  seedTxn(db, { id: 'plaid-xfer', accountId: 'chk', date: d, amountCents: -500, plaidCategory: 'TRANSFER_OUT_ACCOUNT_TRANSFER' });
  seedTxn(db, { id: 'card-pay', accountId: 'chk', date: d, amountCents: -500, plaidCategory: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  seedTxn(db, { id: 'plaid-food', accountId: 'chk', date: d, amountCents: -500, plaidCategory: 'FOOD_AND_DRINK_COFFEE' });
  seedTxn(db, { id: 'pending', accountId: 'chk', date: d, amountCents: -500, categoryId: 'food', pending: true });
  seedTxn(db, { id: 'removed', accountId: 'chk', date: d, amountCents: -500, categoryId: 'food', removedAt: 'x' });
  seedTxn(db, { id: 'invest', accountId: 'brk', date: d, amountCents: -500 });
  seedTxn(db, { id: 'roommate', accountId: 'chk', date: d, amountCents: -500, personId: 'p1', plaidCategory: 'TRANSFER_OUT_ACCOUNT_TRANSFER' });
  seedTxn(db, { id: 'paid-by', accountId: 'manual', date: d, amountCents: -500, categoryId: 'food', paidByPersonId: 'p1' });
  seedTxn(db, { id: 'apple', accountId: 'chk', date: d, amountCents: -500, source: 'applecard', sourceId: 'a1', categoryId: 'food' });
  seedTxn(db, { id: 'split-xfer', accountId: 'chk', date: d, amountCents: -500 });
  seedSplit(db, { id: 's1', transactionId: 'split-xfer', amountCents: -200, categoryId: 'xfer' });
  seedSplit(db, { id: 's2', transactionId: 'split-xfer', amountCents: -300, categoryId: 'pay' });
  seedTxn(db, { id: 'split-mixed', accountId: 'chk', date: d, amountCents: -500 });
  seedSplit(db, { id: 's3', transactionId: 'split-mixed', amountCents: -200, categoryId: 'xfer' });
  seedSplit(db, { id: 's4', transactionId: 'split-mixed', amountCents: -300, categoryId: 'food' });
}

const EXPECTED = ['apple', 'plaid-food', 'roommate', 'spend', 'split-mixed', 'uncat'];

const needing = (db: Db) =>
  (db.prepare(`SELECT t.id FROM transactions t WHERE ${NEEDS_RECONCILE} ORDER BY t.id`).all() as { id: string }[]).map((r) => r.id);

test('needs reconciling: money out only, transfers, income, card payments, pending, removed, investments and paid-by rows left out', () => {
  const { deps } = makeTestDeps();
  seedAll(deps.db);
  assert.deepEqual(needing(deps.db), EXPECTED);
});

test('a refund in a spending category does not need reconciling', () => {
  const { deps } = makeTestDeps();
  seedAll(deps.db);
  assert.ok(!needing(deps.db).includes('refund'));
});

test('a row paid to a person counts even when Plaid calls it a transfer', () => {
  const { deps } = makeTestDeps();
  seedAll(deps.db);
  assert.ok(needing(deps.db).includes('roommate'));
});

test('migration 016 marks exactly the rows that need reconciling before 2026-09-01', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-m16-'));
  const db = openDb(join(dir, 'h.db'));
  const m = join(import.meta.dirname, '..', 'migrations');
  db.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of readdirSync(m).filter((x) => /^\d{3}_.+\.sql$/.test(x) && Number(x.slice(0, 3)) <= 15).sort()) {
    db.exec(readFileSync(join(m, f), 'utf8'));
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(Number(f.slice(0, 3)), 'x');
  }
  seedAll(db);
  seedTxn(db, { id: 'september', accountId: 'chk', date: '2026-09-01', amountCents: -500, categoryId: 'food' });
  assert.equal(migrate(db), 16);
  const marked = (db.prepare('SELECT id FROM transactions WHERE reconciled_at IS NOT NULL ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(marked, EXPECTED);
  const row = db.prepare("SELECT reconciled_cents FROM transactions WHERE id = 'spend'").get() as { reconciled_cents: number };
  assert.equal(row.reconciled_cents, -500);
});

test('Transaction reports reconciled only while the amount matches, and hasReceipt', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk' });
  seedTxn(deps.db, { id: 't1', accountId: 'chk', date: '2026-03-01', amountCents: -500 });
  assert.equal(getTransaction(deps.db, 't1')?.reconciled, false);
  assert.equal(getTransaction(deps.db, 't1')?.hasReceipt, false);
  deps.db.prepare("UPDATE transactions SET reconciled_at = 'x', reconciled_cents = -500 WHERE id = 't1'").run();
  assert.equal(getTransaction(deps.db, 't1')?.reconciled, true);
  deps.db.prepare("UPDATE transactions SET amount_cents = -650 WHERE id = 't1'").run();
  assert.equal(getTransaction(deps.db, 't1')?.reconciled, false);
  deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('t1', x'FFD8FF00', 4, 'x')").run();
  assert.equal(getTransaction(deps.db, 't1')?.hasReceipt, true);
});
