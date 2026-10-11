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

function splitT1(deps: ReturnType<typeof setup>['deps']) {
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -2000, payee: 'Synthetic Store', source: 'plaid',
    sourceId: 's1', plaidCategory: 'GENERAL_MERCHANDISE_ONLINE' });
  seedSplit(deps.db, { id: 'l1', transactionId: 't1', amountCents: -1000, categoryId: 'c-food' });
  seedSplit(deps.db, { id: 'l2', transactionId: 't1', amountCents: -1000, categoryId: 'c-fun' });
}
const patchLine = (app: ReturnType<typeof buildApp>, url: string, key: string, payload: object) =>
  app.inject({ method: 'PATCH', url, headers: w(key), payload });

test('PATCH a line renames, re-tags and notes only that line, keeping its id', async () => {
  const { deps, app } = setup();
  splitT1(deps);
  const res = await patchLine(app, '/v1/transactions/t1/lines/l1', 'k1', { payee: ' Synthetic Lamp ', categoryId: 'c-fun', notes: 'desk' });
  assert.equal(res.statusCode, 200);
  const [l1, l2] = res.json().splitLines;
  assert.deepEqual([l1.id, l1.payee, l1.categoryId, l1.notes], ['l1', 'Synthetic Lamp', 'c-fun', 'desk']);
  assert.deepEqual([l2.id, l2.payee, l2.categoryId], ['l2', null, 'c-fun']);
  assert.equal(res.json().payee, 'Synthetic Store');
  const cleared = await patchLine(app, '/v1/transactions/t1/lines/l1', 'k2', { payee: '   ' });
  assert.equal(cleared.json().splitLines[0].payee, null, 'blank clears the name');
  const nulled = await patchLine(app, '/v1/transactions/t1/lines/l1', 'k3', { payee: 'Synthetic Lamp' });
  assert.equal(nulled.json().splitLines[0].payee, 'Synthetic Lamp');
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/l1', 'k4', { payee: null })).json().splitLines[0].payee, null);
});

test('a person on a line clears its category and the reverse; a line category teaches nothing', async () => {
  const { deps, app } = setup();
  splitT1(deps);
  const toPerson = await patchLine(app, '/v1/transactions/t1/lines/l1', 'k1', { personId: 'p1' });
  assert.deepEqual([toPerson.json().splitLines[0].personId, toPerson.json().splitLines[0].categoryId], ['p1', null]);
  const toCategory = await patchLine(app, '/v1/transactions/t1/lines/l1', 'k2', { categoryId: 'c-food' });
  assert.deepEqual([toCategory.json().splitLines[0].personId, toCategory.json().splitLines[0].categoryId], [null, 'c-food']);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM plaid_category_map').get() as { n: number }).n, 0);
  const both = await patchLine(app, '/v1/transactions/t1/lines/l1', 'k3', { categoryId: 'c-food', personId: 'p1' });
  assert.equal(both.statusCode, 400);
});

test('PATCH a line: 404 for an unknown, removed or other transaction line, or a stale id after a re-split; 400 for bad input', async () => {
  const { deps, app } = setup();
  splitT1(deps);
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-01', amountCents: -100 });
  assert.equal((await patchLine(app, '/v1/transactions/missing/lines/l1', 'k1', { notes: 'x' })).statusCode, 404);
  assert.equal((await patchLine(app, '/v1/transactions/t2/lines/l1', 'k2', { notes: 'x' })).statusCode, 404);
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/nope', 'k3', { notes: 'x' })).statusCode, 404);
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/l1', 'k4', {})).statusCode, 400);
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/l1', 'k5', { categoryId: 'c-missing' })).statusCode, 400);
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/l1', 'k6', { personId: 'p-missing' })).statusCode, 400);
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/l1', 'k7', { payee: 'x'.repeat(201) })).statusCode, 400);
  await app.inject({ method: 'PUT', url: '/v1/transactions/t1/splits', headers: w('k8'), payload: { lines: [
    { amountCents: -1000, categoryId: 'c-food' }, { amountCents: -1000, categoryId: 'c-fun' },
  ] } });
  assert.equal((await patchLine(app, '/v1/transactions/t1/lines/l1', 'k9', { notes: 'x' })).statusCode, 404, 'a re-split mints new line ids');
  deps.db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id = 't1'").run();
  const line = (deps.db.prepare("SELECT id FROM split_lines WHERE transaction_id = 't1' LIMIT 1").get() as { id: string }).id;
  assert.equal((await patchLine(app, `/v1/transactions/t1/lines/${line}`, 'k10', { notes: 'x' })).statusCode, 404);
});

test('PATCH a line replays the same answer for the same idempotency key', async () => {
  const { deps, app } = setup();
  splitT1(deps);
  const a = await patchLine(app, '/v1/transactions/t1/lines/l1', 'same', { payee: 'Synthetic Lamp' });
  const b = await patchLine(app, '/v1/transactions/t1/lines/l1', 'same', { payee: 'Synthetic Lamp' });
  assert.deepEqual(b.json(), a.json());
});
