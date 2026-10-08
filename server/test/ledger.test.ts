import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { makeTestDeps, AUTH, seedAccount, seedCategory, seedTxn, seedSplit } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  seedCategory(deps.db, { id: 'c-fun', name: 'Fun' });
  return { deps, app: buildApp(deps) };
}
const w = (key: string) => ({ ...AUTH, 'idempotency-key': key });

test('list is newest first, excludes removed, and pages with a cursor', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -100 });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-02', amountCents: -200 });
  seedTxn(deps.db, { id: 't3', accountId: 'a1', date: '2026-03-03', amountCents: -300 });
  seedTxn(deps.db, { id: 'gone', accountId: 'a1', date: '2026-03-04', amountCents: -1, removedAt: 'x' });
  const p1 = (await app.inject({ method: 'GET', url: '/v1/transactions?limit=2', headers: AUTH })).json();
  assert.deepEqual(p1.transactions.map((t: { id: string }) => t.id), ['t3', 't2']);
  assert.ok(p1.nextCursor);
  const p2 = (await app.inject({ method: 'GET', url: `/v1/transactions?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, headers: AUTH })).json();
  assert.deepEqual(p2.transactions.map((t: { id: string }) => t.id), ['t1']);
  assert.equal(p2.nextCursor, null);
});

test('search matches payee, merchant, description and notes; % is literal', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -1, merchantName: 'Synthetic Cafe' });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-01', amountCents: -1, bankDescription: '100% SYNTHETIC' });
  const q = async (s: string) => (await app.inject({ method: 'GET', url: `/v1/transactions?q=${encodeURIComponent(s)}`, headers: AUTH })).json().transactions.map((t: { id: string }) => t.id);
  assert.deepEqual(await q('cafe'), ['t1']);
  assert.deepEqual(await q('100%'), ['t2']);
  assert.deepEqual(await q('%'), ['t2']);
});

test('detail returns display payee and split lines; unknown id is 404', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -500, merchantName: 'Synthetic Shop' });
  seedSplit(deps.db, { id: 's1', transactionId: 't1', amountCents: -300, categoryId: 'c-food' });
  seedSplit(deps.db, { id: 's2', transactionId: 't1', amountCents: -200, categoryId: 'c-fun' });
  const t = (await app.inject({ method: 'GET', url: '/v1/transactions/t1', headers: AUTH })).json();
  assert.equal(t.payee, 'Synthetic Shop');
  assert.equal(t.splitLines.length, 2);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/transactions/nope', headers: AUTH })).statusCode, 404);
});

test('patch sets owner fields only', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -500, source: 'plaid', sourceId: 'p1' });
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: w('p-1'), payload: { categoryId: 'c-food', payee: 'Mine', notes: 'n' } });
  assert.equal(res.statusCode, 200);
  const t = res.json();
  assert.equal(t.categoryId, 'c-food');
  assert.equal(t.payee, 'Mine');
  assert.equal(t.amountCents, -500);
});

test('categorizing a bank row learns its Plaid category and fills only matching uncategorized unsplit bank rows', async () => {
  const { deps, app } = setup();
  const pc = 'FOOD_AND_DRINK_COFFEE';
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: 'p1', plaidCategory: pc });
  seedTxn(deps.db, { id: 'same', accountId: 'a1', date: '2026-03-02', amountCents: -1, source: 'applecard', sourceId: 'ac1', plaidCategory: pc });
  seedTxn(deps.db, { id: 'mine', accountId: 'a1', date: '2026-03-02', amountCents: -1, source: 'plaid', sourceId: 'p2', plaidCategory: pc, categoryId: 'c-fun' });
  seedTxn(deps.db, { id: 'split', accountId: 'a1', date: '2026-03-02', amountCents: -1, source: 'plaid', sourceId: 'p3', plaidCategory: pc });
  seedSplit(deps.db, { id: 's1', transactionId: 'split', amountCents: -1, categoryId: null });
  seedTxn(deps.db, { id: 'other', accountId: 'a1', date: '2026-03-02', amountCents: -1, source: 'plaid', sourceId: 'p4', plaidCategory: 'FOOD_AND_DRINK_GROCERIES' });
  seedTxn(deps.db, { id: 'manual', accountId: 'a1', date: '2026-03-02', amountCents: -1, plaidCategory: pc });
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: w('p-learn'), payload: { categoryId: 'c-food' } });
  assert.equal(res.statusCode, 200);
  const cat = (id: string) => (deps.db.prepare('SELECT category_id AS c FROM transactions WHERE id = ?').get(id) as { c: string | null }).c;
  assert.deepEqual(['t1', 'same', 'mine', 'split', 'other', 'manual'].map(cat), ['c-food', 'c-food', 'c-fun', null, null, null]);
  assert.deepEqual(deps.db.prepare('SELECT plaid_category, category_id FROM plaid_category_map').all(), [{ plaid_category: pc, category_id: 'c-food' }]);
});

test('a later categorization replaces the learned mapping and skips removed rows', async () => {
  const { deps, app } = setup();
  const pc = 'FOOD_AND_DRINK_COFFEE';
  deps.db.prepare('INSERT INTO plaid_category_map (plaid_category, category_id) VALUES (?, ?)').run(pc, 'c-food');
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: 'p1', plaidCategory: pc });
  seedTxn(deps.db, { id: 'gone', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: 'p2', plaidCategory: pc, removedAt: 'x' });
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: w('p-relearn'), payload: { categoryId: 'c-fun' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(deps.db.prepare('SELECT category_id FROM plaid_category_map').all(), [{ category_id: 'c-fun' }]);
  assert.equal((deps.db.prepare("SELECT category_id AS c FROM transactions WHERE id = 'gone'").get() as { c: string | null }).c, null);
});

test('a category the owner cleared is not refilled when another row teaches the mapping', async () => {
  const { deps, app } = setup();
  const pc = 'FOOD_AND_DRINK_COFFEE';
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: 'p1', plaidCategory: pc, categoryId: 'c-fun' });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: 'p2', plaidCategory: pc });
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: w('p-clear'), payload: { categoryId: null } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/transactions/t2', headers: w('p-teach'), payload: { categoryId: 'c-food' } })).statusCode, 200);
  assert.equal((deps.db.prepare("SELECT category_id AS c FROM transactions WHERE id = 't1'").get() as { c: string | null }).c, null);
});

test('categorizing a transfer, income or card payment row learns nothing', async () => {
  const { deps, app } = setup();
  const pcs = ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'TRANSFER_IN_DEPOSIT', 'INCOME_SALARY'];
  pcs.forEach((pc, i) => {
    seedTxn(deps.db, { id: `t${i}`, accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: `p${i}`, plaidCategory: pc });
    seedTxn(deps.db, { id: `o${i}`, accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: `q${i}`, plaidCategory: pc });
  });
  for (const i of pcs.keys()) {
    const res = await app.inject({ method: 'PATCH', url: `/v1/transactions/t${i}`, headers: w(`p-nolearn-${i}`), payload: { categoryId: 'c-food' } });
    assert.equal(res.statusCode, 200);
  }
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM plaid_category_map').get() as { n: number }).n, 0);
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id LIKE 'o%' AND category_id IS NOT NULL").get() as { n: number }).n, 0);
});

test('unknown categoryId is a 400 field error', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -500 });
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: w('p-2'), payload: { categoryId: 'c-missing' } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { code: 'INVALID_REQUEST', message: 'categoryId: unknown category', field: 'categoryId' });
});

test('patch on a removed transaction is 404', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -1, removedAt: 'x' });
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: w('p-3'), payload: { notes: 'x' } });
  assert.equal(res.statusCode, 404);
});

test('create adds a manual transaction once per key', async () => {
  const { deps, app } = setup();
  const body = { accountId: 'a1', date: '2026-03-05', amountCents: -1250, payee: 'Synthetic Lunch', categoryId: 'c-food' };
  const a = await app.inject({ method: 'POST', url: '/v1/transactions', headers: w('c-1'), payload: body });
  const b = await app.inject({ method: 'POST', url: '/v1/transactions', headers: w('c-1'), payload: body });
  assert.equal(a.statusCode, 201);
  assert.equal(b.json().id, a.json().id);
  assert.equal(a.json().source, 'manual');
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 1);
});

test('create rejects an unknown account', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: '/v1/transactions', headers: w('c-2'), payload: { accountId: 'nope', date: '2026-03-05', amountCents: -1, payee: 'x' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().field, 'accountId');
});

test('delete works for manual rows only', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 'm1', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'manual' });
  seedTxn(deps.db, { id: 'b1', accountId: 'a1', date: '2026-03-01', amountCents: -1, source: 'plaid', sourceId: 'p9' });
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/transactions/m1', headers: w('d-1') })).statusCode, 200);
  const bank = await app.inject({ method: 'DELETE', url: '/v1/transactions/b1', headers: w('d-2') });
  assert.equal(bank.statusCode, 409);
  assert.equal(bank.json().code, 'BANK_TRANSACTION');
});

test('accounts and categories list', async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: 'GET', url: '/v1/accounts', headers: AUTH })).json().length, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/categories', headers: AUTH })).json().length, 2);
});

test('categoryId filter matches the transaction category or any split line category', async () => {
  const { deps, app } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -100, categoryId: 'c-food' });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-02', amountCents: -500 });
  seedSplit(deps.db, { id: 's1', transactionId: 't2', amountCents: -300, categoryId: 'c-food' });
  seedSplit(deps.db, { id: 's2', transactionId: 't2', amountCents: -200, categoryId: 'c-fun' });
  seedTxn(deps.db, { id: 't3', accountId: 'a1', date: '2026-03-03', amountCents: -100, categoryId: 'c-fun' });
  const ids = async (c: string) => (await app.inject({ method: 'GET', url: `/v1/transactions?categoryId=${c}`, headers: AUTH })).json().transactions.map((t: { id: string }) => t.id);
  assert.deepEqual(await ids('c-food'), ['t2', 't1']);
  assert.deepEqual(await ids('c-fun'), ['t3', 't2']);
});
