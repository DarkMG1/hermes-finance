import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { fitSplitToAmount } from '../src/ledger.ts';
import { makeTestDeps, AUTH, seedAccount, seedCategory, seedTxn, seedSplit, seedPerson } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  seedCategory(deps.db, { id: 'c-fun', name: 'Fun' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  return { deps, app: buildApp(deps) };
}
const w = (key: string) => ({ ...AUTH, 'idempotency-key': key });

test('split lines carry their own trimmed name; blank or missing stores null', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -3000, payee: 'Synthetic Store' });
  const res = await app.inject({ method: 'PUT', url: '/v1/transactions/t1/splits', headers: w('k1'), payload: { lines: [
    { amountCents: -1000, categoryId: 'c-food', payee: '  Synthetic Lamp  ' },
    { amountCents: -1000, categoryId: 'c-fun', payee: '   ' },
    { amountCents: -1000, categoryId: null, personId: 'p1' },
  ] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().splitLines.map((l: { payee: string | null }) => l.payee), ['Synthetic Lamp', null, null]);
  assert.equal(res.json().payee, 'Synthetic Store', "the transaction's payee is unchanged");
  const tooLong = await app.inject({ method: 'PUT', url: '/v1/transactions/t1/splits', headers: w('k2'), payload: { lines: [
    { amountCents: -1500, categoryId: null, payee: 'x'.repeat(201) }, { amountCents: -1500, categoryId: null },
  ] } });
  assert.equal(tooLong.statusCode, 400);
});

test('re-saving a split without names clears them (the app sends names back)', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -2000 });
  seedSplit(deps.db, { id: 'l1', transactionId: 't1', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Lamp' });
  seedSplit(deps.db, { id: 'l2', transactionId: 't1', amountCents: -1000, categoryId: 'c-fun' });
  const res = await app.inject({ method: 'PUT', url: '/v1/transactions/t1/splits', headers: w('k1'), payload: { lines: [
    { amountCents: -1000, categoryId: 'c-food' }, { amountCents: -1000, categoryId: 'c-fun' },
  ] } });
  assert.deepEqual(res.json().splitLines.map((l: { payee: string | null }) => l.payee), [null, null]);
});

test('a bank amount change resizes lines and keeps their names', () => {
  const { deps } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -2000 });
  seedSplit(deps.db, { id: 'l1', transactionId: 't1', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Lamp' });
  seedSplit(deps.db, { id: 'l2', transactionId: 't1', amountCents: -1000, categoryId: 'c-fun' });
  deps.db.prepare('UPDATE transactions SET amount_cents = -3000 WHERE id = ?').run('t1');
  fitSplitToAmount(deps.db, 't1', '2026-03-15T12:00:00Z');
  const rows = deps.db.prepare('SELECT amount_cents AS a, payee FROM split_lines WHERE transaction_id = ? ORDER BY id').all('t1');
  assert.deepEqual(rows, [{ a: -1500, payee: 'Synthetic Lamp' }, { a: -1500, payee: null }]);
});

test("search finds a transaction by a split line's name", async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -2000, payee: 'Synthetic Store' });
  seedSplit(deps.db, { id: 'l1', transactionId: 't1', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Lamp' });
  seedSplit(deps.db, { id: 'l2', transactionId: 't1', amountCents: -1000, categoryId: 'c-fun' });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-02', amountCents: -100, payee: 'Synthetic Other' });
  const ids = (await app.inject({ method: 'GET', url: '/v1/transactions?q=lamp', headers: AUTH })).json().transactions.map((t: { id: string }) => t.id);
  assert.deepEqual(ids, ['t1']);
});

test("a person's feed shows a line under its own name, else the transaction's payee", async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -2000, payee: 'Synthetic Store' });
  seedSplit(deps.db, { id: 'l1', transactionId: 't1', amountCents: -1000, categoryId: 'c-food' });
  seedSplit(deps.db, { id: 'l2', transactionId: 't1', amountCents: -1000, categoryId: null, personId: 'p1', payee: 'Synthetic Lamp' });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-02', amountCents: -400, payee: 'Synthetic Cafe' });
  seedSplit(deps.db, { id: 'm1', transactionId: 't2', amountCents: -200, categoryId: 'c-food' });
  seedSplit(deps.db, { id: 'm2', transactionId: 't2', amountCents: -200, categoryId: null, personId: 'p1' });
  const history = (await app.inject({ method: 'GET', url: '/v1/people/p1', headers: AUTH })).json().history as { lineId: string; payee: string }[];
  assert.deepEqual(Object.fromEntries(history.map((h) => [h.lineId, h.payee])), { l2: 'Synthetic Lamp', m2: 'Synthetic Cafe' });
});
