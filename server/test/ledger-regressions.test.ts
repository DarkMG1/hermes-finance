import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaveItemsBody, Spending, type Transaction } from '@hermes/shared';
import { buildApp } from '../src/app.ts';
import { fitSplitToAmount, getTransaction, listTransactions } from '../src/ledger.ts';
import { writeSplit } from '../src/routes/ledger.ts';
import { applyPages } from '../src/sync/apply.ts';
import { txn } from './fake-plaid.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedItem, seedPerson, seedSplit, seedTxn } from './helpers.ts';

const w = (key: string) => ({ ...AUTH, 'idempotency-key': key });

test('legacy split replacements cannot erase names or people; explicit nulls clear them', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedPerson(deps.db, { id: 'p', name: 'Synthetic Quill' });
  seedTxn(deps.db, { id: 't', accountId: 'manual', date: '2026-03-01', amountCents: -200 });
  seedSplit(deps.db, { id: 'a', transactionId: 't', amountCents: -100, categoryId: null, payee: 'Synthetic Lamp' });
  seedSplit(deps.db, { id: 'b', transactionId: 't', amountCents: -100, categoryId: null, personId: 'p' });
  const before = getTransaction(deps.db, 't');
  const full = [{ amountCents: -100, categoryId: null, personId: null, payee: null }, { amountCents: -100, categoryId: null, personId: null, payee: null }];
  for (const missing of ['personId', 'payee'] as const) {
    const lines = full.map((l) => ({ ...l, [missing]: undefined }));
    const res = await app.inject({ method: 'PUT', url: '/v1/transactions/t/splits', headers: w(missing), payload: { lines } });
    assert.deepEqual([res.statusCode, res.json().code], [409, 'APP_OUTDATED']);
    assert.deepEqual(getTransaction(deps.db, 't'), before);
  }
  const cleared = await app.inject({ method: 'PUT', url: '/v1/transactions/t/splits', headers: w('clear'), payload: { lines: full } });
  assert.equal(cleared.statusCode, 200);
  assert.ok(cleared.json<Transaction>().splitLines.every((l) => l.personId === null && l.payee === null));
});

test('an archived person can retain their role but cannot move from For to Paid by or back', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedPerson(deps.db, { id: 'p', name: 'Synthetic Quill', archived: true });
  seedTxn(deps.db, { id: 'for', accountId: 'manual', date: '2026-03-01', amountCents: -200, personId: 'p' });
  seedTxn(deps.db, { id: 'paid', accountId: 'manual', date: '2026-03-01', amountCents: -200, paidByPersonId: 'p' });
  for (const [id, payload] of [['for', { personId: null, paidByPersonId: 'p' }], ['paid', { paidByPersonId: null, personId: 'p' }]] as const) {
    const before = getTransaction(deps.db, id);
    const res = await app.inject({ method: 'PATCH', url: `/v1/transactions/${id}`, headers: w(id), payload });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(getTransaction(deps.db, id), before);
  }
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/transactions/paid', headers: w('keep'), payload: { paidByPersonId: 'p' } })).statusCode, 200);
  deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('paid', x'ffd8ff', 3, 'seed')").run();
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/transactions/paid/receipt/items', headers: w('items'), payload: {
    items: [{ name: 'Synthetic Item', amountCents: 400, people: ['me', 'p'] }], taxCents: 0, tipCents: 0, feesCents: 0,
  } })).statusCode, 200, 'an archived payer can still itemize the same receipt');
});

test('a collapsed split keeps the winning name, category and person, or the parent name for an unnamed winner', () => {
  const { deps } = makeTestDeps();
  seedPerson(deps.db, { id: 'p', name: 'Synthetic Quill' });
  seedCategory(deps.db, { id: 'c', name: 'Synthetic Category' });
  for (const [id, name, personId, categoryId, amount] of [
    ['named', 'Synthetic Lamp', undefined, 'c', -1], ['tagged', 'Synthetic Share', 'p', null, 1], ['unnamed', undefined, undefined, 'c', -1],
  ] as const) {
    seedTxn(deps.db, { id, accountId: 'manual', date: '2026-03-01', amountCents: amount, payee: 'Synthetic Parent' });
    seedSplit(deps.db, { id: `${id}-a`, transactionId: id, amountCents: -99, categoryId, personId, payee: name });
    seedSplit(deps.db, { id: `${id}-b`, transactionId: id, amountCents: -1, categoryId: null });
    fitSplitToAmount(deps.db, id, 'now');
    const row = getTransaction(deps.db, id)!;
    assert.deepEqual([row.payee, row.categoryId, row.personId, row.splitLines], [name ?? 'Synthetic Parent', categoryId, personId ?? null, []]);
  }
});

test('explicit Zelle payee edits survive empty sync, promotion and later bank corrections', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedItem(deps, { id: 'i', plaidItemId: 'pi', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  seedAccount(deps.db, { id: 'a', itemId: 'i', plaidAccountId: 'pa1' });
  const bank = 'Zelle payment from SYNTHETIC QUILL 123';
  const apply = (added: ReturnType<typeof txn>[] = [], modified: ReturnType<typeof txn>[] = []) => applyPages(deps.db,
    [{ added, modified, removed: [], nextCursor: 'c', hasMore: false }], { itemId: 'i', cutoverDate: null, nowIso: deps.now().toISOString() });
  for (const [key, payee] of [['null', null], ['bank', bank], ['name', 'Synthetic Wren']] as const) {
    apply([txn({ transactionId: key, pending: true, name: bank, merchantName: null })]);
    const id = (deps.db.prepare('SELECT id FROM transactions WHERE source_id = ?').get(key) as { id: string }).id;
    assert.equal((await app.inject({ method: 'PATCH', url: `/v1/transactions/${id}`, headers: w(key), payload: { payee } })).statusCode, 200);
    apply();
    assert.deepEqual(deps.db.prepare('SELECT payee, payee_owner_set FROM transactions WHERE id = ?').get(id), { payee, payee_owner_set: 1 });
    apply([txn({ transactionId: `${key}-posted`, pendingTransactionId: key, name: bank, merchantName: null })]);
    apply([], [txn({ transactionId: `${key}-posted`, name: bank, merchantName: null, amount: 17 })]);
    assert.deepEqual(deps.db.prepare('SELECT payee, payee_owner_set FROM transactions WHERE source_id = ?').get(`${key}-posted`), { payee, payee_owner_set: 1 });
  }
  apply([txn({ transactionId: 'untouched', name: bank, merchantName: null })]);
  assert.deepEqual(deps.db.prepare("SELECT payee, payee_owner_set FROM transactions WHERE source_id = 'untouched'").get(), { payee: 'Zelle - Synthetic', payee_owner_set: 0 });
});

test('encoded plus signs reach the transaction search unchanged', async () => {
  const { deps } = makeTestDeps();
  seedTxn(deps.db, { id: 'plus', accountId: 'manual', date: '2026-03-01', amountCents: -1, payee: 'Synthetic A+B' });
  seedTxn(deps.db, { id: 'space', accountId: 'manual', date: '2026-03-01', amountCents: -1, payee: 'Synthetic A B' });
  const r = await buildApp(deps).inject({ method: 'GET', url: '/v1/transactions?q=Synthetic%20A%2BB', headers: AUTH });
  assert.deepEqual(r.json().transactions.map((t: Transaction) => t.id), ['plus']);
});

test('people all=0 returns the default filtered list', async () => {
  const { deps } = makeTestDeps();
  seedPerson(deps.db, { id: 'p', name: 'Synthetic Quill', archived: true });
  const app = buildApp(deps);
  const r = await app.inject({ method: 'GET', url: '/v1/people?all=0', headers: AUTH });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), (await app.inject({ method: 'GET', url: '/v1/people', headers: AUTH })).json());
  assert.equal((await app.inject({ method: 'GET', url: '/v1/people?all=1', headers: AUTH })).json().length, 1);
});

test('date inputs leave room for a valid exclusive year boundary', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const create = (date: string) => app.inject({ method: 'POST', url: '/v1/transactions', headers: w(date), payload: { date, amountCents: -1234, payee: 'Synthetic Lamp' } });
  assert.equal((await create('9999-12-31')).statusCode, 400);
  const last = await create('9998-12-31');
  assert.equal(last.statusCode, 201);
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/transactions/${last.json().id}`, headers: w('date'), payload: { date: '9999-01-01' } })).statusCode, 400);
  for (const query of ['period=month&date=9998-12', 'period=year&date=9998']) {
    const r = await app.inject({ method: 'GET', url: `/v1/spending?${query}`, headers: AUTH });
    assert.equal(r.statusCode, 200);
    assert.equal(Spending.parse(r.json()).outCents, 1234);
    assert.equal(r.json().toExclusive, '9999-01-01');
  }
  for (const url of ['/v1/spending?period=month&date=9999-12', '/v1/spending?period=year&date=9999', '/v1/expenses?period=year&date=9999',
    '/v1/reconcile?month=9999-12', '/v1/payee-history?name=Synthetic&month=9999-12', '/v1/transactions?from=9999-01-01']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: AUTH })).statusCode, 400, url);
  }
});

test('Home aggregates people once while including reopened archived balances and matching only active people', async (t) => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a', subtype: 'checking' });
  seedPerson(deps.db, { id: 'p', name: 'Synthetic Quill', archived: true, matchText: 'SYNTHETIC MATCH' });
  seedPerson(deps.db, { id: 'q', name: 'Synthetic Wren' });
  seedTxn(deps.db, { id: 'owed', accountId: 'a', date: '2026-03-01', amountCents: -500, personId: 'p' });
  seedTxn(deps.db, { id: 'owe', accountId: 'a', date: '2026-03-01', amountCents: 200, personId: 'q' });
  seedTxn(deps.db, { id: 'deposit', accountId: 'a', date: '2026-03-02', amountCents: 500, bankDescription: 'SYNTHETIC MATCH' });
  const prepare = deps.db.prepare.bind(deps.db);
  let aggregates = 0;
  t.mock.method(deps.db, 'prepare', (sql: string) => { if (sql.includes('-SUM(amount)')) aggregates += 1; return prepare(sql); });
  const r = await buildApp(deps).inject({ method: 'GET', url: '/v1/home', headers: AUTH });
  assert.deepEqual([r.json().owedToYouCents, r.json().youOweCents, r.json().repaymentSuggestions], [500, 200, 0]);
  assert.equal(aggregates, 1);
});

test('transaction pages batch split and receipt reads without losing metadata or order', (t) => {
  const { deps } = makeTestDeps();
  for (let i = 0; i < 200; i += 1) {
    const id = `t${String(i).padStart(3, '0')}`;
    seedTxn(deps.db, { id, accountId: 'manual', date: '2026-03-01', amountCents: -30 });
    if (i % 2 === 0) {
      seedSplit(deps.db, { id: `${id}-b`, transactionId: id, amountCents: -20, categoryId: null, payee: 'Synthetic Fern' });
      seedSplit(deps.db, { id: `${id}-a`, transactionId: id, amountCents: -10, categoryId: null, payee: 'Synthetic Moss' });
      deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, x'ffd8ff', 3, 'seed')").run(id);
    }
  }
  const prepare = deps.db.prepare.bind(deps.db);
  let reads = 0;
  t.mock.method(deps.db, 'prepare', (sql: string) => { reads += 1; return prepare(sql); });
  const page = listTransactions(deps.db, { limit: 200 });
  assert.equal(page.transactions.length, 200);
  assert.equal(page.nextCursor, null);
  assert.ok(reads < 20, `${reads} queries for one page`);
  for (const row of page.transactions) {
    const split = Number(row.id.slice(1)) % 2 === 0;
    assert.equal(row.hasReceipt, split);
    assert.deepEqual(row.splitLines.map((l) => [l.amountCents, l.payee]), split ? [[-10, 'Synthetic Moss'], [-20, 'Synthetic Fern']] : []);
  }
});

test('itemization caps combined participants at 20 and its saved split can be edited unchanged', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  seedTxn(deps.db, { id: 't', accountId: 'manual', date: '2026-03-01', amountCents: -2100 });
  deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('t', x'ffd8ff', 3, 'seed')").run();
  const people = Array.from({ length: 20 }, (_, i) => `p${i}`);
  for (const id of people) seedPerson(deps.db, { id, name: 'Synthetic Quill' });
  const body = { items: [{ name: 'Synthetic Item', amountCents: 2000, people }, { name: 'Synthetic Owner Item', amountCents: 100, people: ['me'] }], taxCents: 0, tipCents: 0, feesCents: 0 };
  assert.equal(SaveItemsBody.safeParse(body).success, false);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/transactions/t/receipt/items', headers: w('too-many'), payload: body })).statusCode, 400);
  assert.throws(() => writeSplit(deps.db, 't', -2100, Array.from({ length: 21 }, () => ({ amountCents: -100, categoryId: null })), 'items', 'now'));
  assert.deepEqual(getTransaction(deps.db, 't')!.splitLines, []);
  body.items[0]!.people = people.slice(0, 19);
  const saved = await app.inject({ method: 'PUT', url: '/v1/transactions/t/receipt/items', headers: w('valid'), payload: body });
  assert.equal(saved.statusCode, 200);
  const linesOf = (row: Transaction) => row.splitLines.map(({ amountCents, categoryId, notes, personId, payee }) =>
    ({ amountCents, categoryId, notes, personId, payee }));
  const lines = linesOf(saved.json<Transaction>());
  assert.equal(lines.length, 20);
  const edited = await app.inject({ method: 'PUT', url: '/v1/transactions/t/splits', headers: w('edit'), payload: { lines } });
  assert.equal(edited.statusCode, 200);
  assert.deepEqual(linesOf(edited.json<Transaction>()), lines);
});
