import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateTransactionBody, PatchTransactionBody, SpendingQuery, ListTransactionsQuery } from '@hermes/shared';

test('create body requires integer non-zero cents and a real date', () => {
  const ok = CreateTransactionBody.safeParse({ accountId: 'a1', date: '2026-01-31', amountCents: -1250, payee: 'Coffee' });
  assert.equal(ok.success, true);
  assert.equal(CreateTransactionBody.safeParse({ accountId: 'a1', date: '2026-01-31', amountCents: 12.5, payee: 'x' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ accountId: 'a1', date: '2026-01-31', amountCents: 0, payee: 'x' }).success, false);
  assert.equal(CreateTransactionBody.safeParse({ accountId: 'a1', date: '2026-13-01', amountCents: -1, payee: 'x' }).success, false);
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
  const d = (date: string) => CreateTransactionBody.safeParse({ accountId: 'a1', date, amountCents: -1, payee: 'x' }).success;
  assert.equal(d('2026-02-31'), false);
  assert.equal(d('2026-04-31'), false);
  assert.equal(d('2026-02-29'), false);
  assert.equal(d('2024-02-29'), true);
});
