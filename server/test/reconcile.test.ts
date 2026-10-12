import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../src/db.ts';
import { NEEDS_RECONCILE, OPEN } from '../src/reconcile.ts';
import { getTransaction } from '../src/ledger.ts';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

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
  seedTxn(db, { id: 'plaid-income', accountId: 'chk', date: d, amountCents: -500, plaidCategory: 'INCOME_WAGES' });
  seedTxn(db, { id: 'plaid-xfer-in', accountId: 'chk', date: d, amountCents: -500, plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
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

const EXPECTED = ['apple', 'paid-by', 'plaid-food', 'roommate', 'spend', 'split-mixed', 'uncat'];

const needing = (db: Db) =>
  (db.prepare(`SELECT t.id FROM transactions t WHERE ${NEEDS_RECONCILE} ORDER BY t.id`).all() as { id: string }[]).map((r) => r.id);

test('needs reconciling: money out only, transfers, income, card payments, pending, removed, and investments left out; rows someone else paid count', () => {
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

test('migration 016 marks every money-out row before 2026-09-01, whatever the rule selects today', () => {
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
  const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id);
  const moneyOutBefore = ids("SELECT id FROM transactions WHERE date < '2026-09-01' AND amount_cents < 0 ORDER BY id");
  assert.ok(moneyOutBefore.includes('xfer-cat'));
  assert.deepEqual(ids('SELECT id FROM transactions WHERE reconciled_at IS NOT NULL ORDER BY id'), moneyOutBefore);
  assert.ok(!moneyOutBefore.includes('refund') && !moneyOutBefore.includes('september'));
  assert.deepEqual(ids(`SELECT t.id FROM transactions t WHERE t.date < '2026-09-01' AND ${NEEDS_RECONCILE} AND ${OPEN}`), []);
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

function api() {
  const { deps } = makeTestDeps(); // clock: 2026-03-15
  seedAccount(deps.db, { id: 'chk' });
  seedCategory(deps.db, { id: 'food', name: 'Synthetic Food' });
  seedTxn(deps.db, { id: 'jan', accountId: 'chk', date: '2026-01-31', amountCents: -100, categoryId: 'food' });
  seedTxn(deps.db, { id: 'feb-a', accountId: 'chk', date: '2026-02-01', amountCents: -200, categoryId: 'food' });
  seedTxn(deps.db, { id: 'feb-b', accountId: 'chk', date: '2026-02-28', amountCents: -300, categoryId: 'food' });
  seedTxn(deps.db, { id: 'mar', accountId: 'chk', date: '2026-03-01', amountCents: -400, categoryId: 'food' });
  const app = buildApp(deps);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const mark = async (id: string, reconciled: boolean, key = `k-${id}-${reconciled}`, amountCents?: number) =>
    app.inject({ method: 'POST', url: `/v1/transactions/${id}/reconcile`, headers: { ...AUTH, 'idempotency-key': key },
      payload: amountCents === undefined ? { reconciled } : { reconciled, amountCents } });
  return { deps, get, mark };
}

test('a month lists its open rows oldest first, with month boundaries', async () => {
  const { get } = api();
  const feb = await get('/v1/reconcile?month=2026-02');
  assert.equal(feb.total, 2);
  assert.equal(feb.open, 2);
  assert.deepEqual(feb.transactions.map((t: { id: string }) => t.id), ['feb-a', 'feb-b']);
});

test('marking closes a row, unmarking re-opens it, and a bank amount change re-opens it', async () => {
  const { deps, get, mark } = api();
  const res = await mark('feb-a', true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reconciled, true);
  assert.equal((await get('/v1/reconcile?month=2026-02')).open, 1);
  deps.db.prepare("UPDATE transactions SET amount_cents = -250 WHERE id = 'feb-a'").run();
  assert.equal((await get('/v1/reconcile?month=2026-02')).open, 2);
  await mark('feb-a', true, 'k2');
  deps.db.prepare("UPDATE transactions SET notes = 'edited', category_id = NULL WHERE id = 'feb-a'").run();
  assert.equal((await get('/v1/reconcile?month=2026-02')).open, 1, 'owner edits never re-open');
  await mark('feb-a', false);
  assert.equal((await get('/v1/reconcile?month=2026-02')).open, 2);
});

test('months lists every month with open rows; Home shows the oldest finished one only', async () => {
  const { get, mark } = api();
  assert.deepEqual((await get('/v1/reconcile/months')).months,
    [{ month: '2026-01', open: 1 }, { month: '2026-02', open: 2 }, { month: '2026-03', open: 1 }]);
  assert.deepEqual((await get('/v1/home')).toReconcile, { month: '2026-01', open: 1 });
  await mark('jan', true);
  await mark('feb-a', true);
  await mark('feb-b', true);
  assert.equal((await get('/v1/home')).toReconcile, null, 'the current month never nags');
});

test('reconcile rejects bad input and unknown rows', async () => {
  const { get, mark } = api();
  assert.equal((await get('/v1/reconcile?month=2026-13')).code, 'INVALID_REQUEST');
  assert.equal((await mark('missing', true)).statusCode, 404);
});

test('marking with the amount the owner saw: a stale amount is 409 and writes nothing, a matching one marks', async () => {
  const { deps, get, mark } = api();
  const stale = await mark('feb-a', true, 'k-stale', -150);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'AMOUNT_CHANGED');
  assert.equal(getTransaction(deps.db, 'feb-a')?.reconciled, false);
  assert.equal((await get('/v1/reconcile?month=2026-02')).open, 2);
  const ok = await mark('feb-a', true, 'k-match', -200);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().reconciled, true);
  assert.equal((await mark('feb-a', false, 'k-un', -999)).statusCode, 200, 'unmarking ignores the amount');
  assert.equal((await mark('missing', true, 'k-miss', -200)).statusCode, 404);
});
