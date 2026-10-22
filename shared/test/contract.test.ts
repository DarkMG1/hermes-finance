import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateTransactionBody, PatchTransactionBody, SpendingQuery, ListTransactionsQuery, Reconcile, ReconcileSummary, ReconcileQuery, Reimbursements, Transaction } from '@hermes/shared';

test('create body requires integer non-zero cents and a real date', () => {
  const ok = CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents: -1250, payee: 'Coffee' });
  assert.equal(ok.success, true);
  assert.equal(CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents: 12.5, payee: 'x' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents: 0, payee: 'x' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ date: '2026-13-01', amountCents: -1, payee: 'x' }).success, false);
});

test('patch body needs at least one field and allows clearing with null', () => {
  assert.equal(PatchTransactionBody.safeParse({}).success, false);
  assert.equal(PatchTransactionBody.safeParse({ categoryId: null }).success, true);
  assert.equal(PatchTransactionBody.safeParse({ notes: 'n', extra: 1 }).success, false);
});

test('spending query date format follows the period', () => {
  assert.equal(SpendingQuery.safeParse({ period: 'month', date: '2026-02' }).success, true);
  assert.equal(SpendingQuery.safeParse({ period: 'year', date: '2026' }).success, true);
  assert.equal(SpendingQuery.safeParse({ period: 'month', date: '2026' }).success, false);
});

test('list query coerces limit and caps it', () => {
  const r = ListTransactionsQuery.parse({ limit: '20' });
  assert.equal(r.limit, 20);
  assert.equal(ListTransactionsQuery.safeParse({ limit: '500' }).success, false);
});

test('patch payee must be non-empty but may be cleared with null', () => {
  assert.equal(PatchTransactionBody.safeParse({ payee: '' }).success, false);
  assert.equal(PatchTransactionBody.safeParse({ payee: null }).success, true);
});

test('dates must be real calendar dates', () => {
  const d = (date: string) => CreateTransactionBody.safeParse({ date, amountCents: -1, payee: 'x' }).success;
  assert.equal(d('2026-02-31'), false);
  assert.equal(d('2026-04-31'), false);
  assert.equal(d('2026-02-29'), false);
  assert.equal(d('2024-02-29'), true);
});

test('date bounds apply to inputs while stored bank dates and months remain valid responses', () => {
  const month = '9999-12';
  assert.equal(ReconcileQuery.safeParse({ month }).success, false);
  assert.equal(SpendingQuery.safeParse({ period: 'month', date: month }).success, false);
  assert.equal(PatchTransactionBody.safeParse({ date: `${month}-31` }).success, false);
  assert.equal(ReconcileSummary.safeParse({ month, open: 1 }).success, true);
  assert.equal(Reconcile.safeParse({ month, total: 0, open: 0, transactions: [] }).success, true);
  assert.equal(Reimbursements.safeParse({ months: [{ month, outCents: 0, inCents: 0, unpaidCents: 0 }], rows: [] }).success, true);
  assert.equal(Transaction.shape.date.safeParse(`${month}-31`).success, true);
});
