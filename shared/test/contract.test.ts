import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateTransactionBody, PatchTransactionBody, PutSplitsBody, SpendingQuery, ListTransactionsQuery, Reconcile, ReconcileSummary, ReconcileQuery, Reimbursements, Transaction } from '@hermes/shared';

test('create body requires integer non-zero cents and a real date', () => {
  const ok = CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents: -1250, payee: 'Coffee' });
  assert.equal(ok.success, true);
  assert.equal(CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents: 12.5, payee: 'x' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents: 0, payee: 'x' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ date: '2026-13-01', amountCents: -1, payee: 'x' }).success, false);
});

test('manual and split amount inputs reject values outside the ledger bound as field errors', () => {
  for (const amountCents of [-1_000_000_001, 1_000_000_001, Number.MAX_SAFE_INTEGER, Infinity]) {
    const manual = CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents, payee: 'Synthetic Quill' });
    const split = PutSplitsBody.safeParse({ lines: [{ amountCents, categoryId: null }, { amountCents: -1, categoryId: null }] });
    assert.equal(manual.success, false);
    assert.equal(split.success, false);
    if (!manual.success) assert.deepEqual(manual.error.issues[0]!.path, ['amountCents']);
    if (!split.success) assert.deepEqual(split.error.issues[0]!.path, ['lines', 0, 'amountCents']);
  }
  for (const amountCents of [-1_000_000_000, 1_000_000_000]) {
    assert.ok(CreateTransactionBody.safeParse({ date: '2026-01-31', amountCents, payee: 'Synthetic Quill' }).success);
  }
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

test('atomic inbox creation requires a payer and keeps existing create requests valid', () => {
  const body = { date: '2026-03-10', amountCents: -1050, payee: 'Synthetic Grocer' };
  assert.equal(CreateTransactionBody.safeParse(body).success, true);
  assert.equal(CreateTransactionBody.safeParse({ ...body, inboxReceiptId: 'r1' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ ...body, inboxReceiptId: 'r1', paidByPersonId: 'p1' }).success, true);
});
