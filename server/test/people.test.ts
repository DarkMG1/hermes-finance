import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { makeTestDeps, AUTH, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill', matchText: 'SYNTHETIC QUILLON' });
  seedPerson(deps.db, { id: 'p2', name: 'Synthetic Wren' });
  const app = buildApp(deps);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const send = (method: 'POST' | 'PATCH' | 'PUT', url: string, key: string, payload: object) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, payload });
  return { deps, app, get, send };
}

test('repayments pay the oldest items first; a removed repayment re-opens them; overpaying puts the person ahead', async () => {
  const { deps, get } = setup();
  seedTxn(deps.db, { id: 'dinner', accountId: 'a1', date: '2026-03-01', amountCents: -6000 });
  seedSplit(deps.db, { id: '00-a', transactionId: 'dinner', amountCents: -3000, categoryId: 'c-food' });
  seedSplit(deps.db, { id: '01-b', transactionId: 'dinner', amountCents: -3000, categoryId: null, personId: 'p1' });
  seedTxn(deps.db, { id: 'tickets', accountId: 'a1', date: '2026-03-05', amountCents: -2000, personId: 'p1' });
  seedTxn(deps.db, { id: 'snacks', accountId: 'a1', date: '2026-03-09', amountCents: -1000, personId: 'p1' });
  seedTxn(deps.db, { id: 'zelle', accountId: 'a1', date: '2026-03-10', amountCents: 4000, personId: 'p1', source: 'plaid', sourceId: 'z1' });
  const d = await get('/v1/people/p1');
  assert.equal(d.person.balanceCents, 2000);
  assert.deepEqual(d.owed.map((o: { transactionId: string; status: string; paidCents: number }) => [o.transactionId, o.status, o.paidCents]),
    [['snacks', 'open', 0], ['tickets', 'partial', 1000], ['dinner', 'paid', 3000]], 'newest first; settled oldest first');
  assert.equal(d.owed[2].lineId, '01-b');
  assert.deepEqual(d.repayments.map((r: { transactionId: string }) => r.transactionId), ['zelle']);
  deps.db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id = 'zelle'").run();
  const removed = await get('/v1/people/p1');
  assert.equal(removed.person.balanceCents, 6000);
  assert.ok(removed.owed.every((o: { status: string }) => o.status === 'open'));
  seedTxn(deps.db, { id: 'big', accountId: 'a1', date: '2026-03-11', amountCents: 7000, personId: 'p1' });
  const ahead = await get('/v1/people/p1');
  assert.equal(ahead.person.balanceCents, -1000);
  assert.ok(ahead.owed.every((o: { status: string }) => o.status === 'paid'));
  assert.equal((await get('/v1/people/nope')).code, 'NOT_FOUND');
});

test('people: create, list by balance, archive only when settled, archived people hidden unless all=1', async () => {
  const { deps, get, send } = setup();
  seedTxn(deps.db, { id: 'lent', accountId: 'a1', date: '2026-03-01', amountCents: -500, personId: 'p2' });
  const created = await send('POST', '/v1/people', 'pc-1', { name: '  Synthetic Moss ', matchText: 'MOSS S' });
  assert.equal(created.statusCode, 201);
  assert.deepEqual({ ...(created.json() as object), id: 'x' }, { id: 'x', name: 'Synthetic Moss', matchText: 'MOSS S', archived: false, balanceCents: 0 });
  assert.deepEqual((await get('/v1/people')).map((p: { name: string }) => p.name), ['Synthetic Wren', 'Synthetic Moss', 'Synthetic Quill'],
    'largest balance first, then by name');
  const refused = await send('PATCH', '/v1/people/p2', 'pa-1', { archived: true });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'PERSON_HAS_BALANCE');
  assert.equal((await send('PATCH', '/v1/people/p1', 'pa-2', { archived: true, name: 'Synthetic Quill R' })).statusCode, 200);
  assert.ok(!(await get('/v1/people')).some((p: { id: string }) => p.id === 'p1'));
  assert.ok((await get('/v1/people?all=1')).some((p: { id: string; archived: boolean }) => p.id === 'p1' && p.archived));
  assert.equal((await send('PATCH', '/v1/people/nope', 'pa-3', { name: 'x' })).statusCode, 404);
  assert.equal((await send('POST', '/v1/people', 'pc-2', { name: '   ' })).statusCode, 400);
});

test('tagging a transaction: person clears category and back; both at once is 400; a split row is 409; archived people cannot be newly tagged', async () => {
  const { deps, get, send } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -500, categoryId: 'c-food' });
  const tagged = await send('PATCH', '/v1/transactions/t1', 'tg-1', { personId: 'p1' });
  assert.equal(tagged.statusCode, 200);
  assert.deepEqual([tagged.json().personId, tagged.json().categoryId], ['p1', null]);
  assert.equal((deps.db.prepare("SELECT category_owner_set AS f FROM transactions WHERE id = 't1'").get() as { f: number }).f, 1);
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 500);
  const back = await send('PATCH', '/v1/transactions/t1', 'tg-2', { categoryId: 'c-food' });
  assert.deepEqual([back.json().personId, back.json().categoryId], [null, 'c-food']);
  assert.equal((await send('PATCH', '/v1/transactions/t1', 'tg-3', { personId: 'p1', categoryId: 'c-food' })).statusCode, 400);
  assert.equal((await send('PATCH', '/v1/transactions/t1', 'tg-4', { personId: 'nope' })).statusCode, 400);
  deps.db.prepare("UPDATE people SET archived = 1 WHERE id = 'p2'").run();
  const archived = await send('PATCH', '/v1/transactions/t1', 'tg-5', { personId: 'p2' });
  assert.equal(archived.statusCode, 400);
  assert.equal(archived.json().field, 'personId');
  seedTxn(deps.db, { id: 's1', accountId: 'a1', date: '2026-03-01', amountCents: -500 });
  seedSplit(deps.db, { id: '00-a', transactionId: 's1', amountCents: -250, categoryId: null });
  seedSplit(deps.db, { id: '01-b', transactionId: 's1', amountCents: -250, categoryId: null });
  const split = await send('PATCH', '/v1/transactions/s1', 'tg-6', { personId: 'p1' });
  assert.equal(split.statusCode, 409);
  assert.equal(split.json().code, 'SPLIT_TRANSACTION');
});

test('split lines take a person; a person line with a category is 400; an archived person already on the split can be re-saved', async () => {
  const { deps, get, send } = setup();
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-01', amountCents: -9000, personId: 'p1' });
  const lines = (personB: string) => [
    { amountCents: -3000, categoryId: 'c-food' }, { amountCents: -3000, categoryId: null, personId: 'p1' },
    { amountCents: -3000, categoryId: null, personId: personB }];
  const ok = await send('PUT', '/v1/transactions/t1/splits', 'sp-1', { lines: lines('p2') });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().splitLines.map((l: { personId: string | null }) => l.personId), [null, 'p1', 'p2']);
  assert.equal(ok.json().personId, null, 'a split row carries its people on its lines');
  assert.equal((await get('/v1/people/p2')).person.balanceCents, 3000);
  const both = await send('PUT', '/v1/transactions/t1/splits', 'sp-2', { lines: [
    { amountCents: -4500, categoryId: 'c-food', personId: 'p1' }, { amountCents: -4500, categoryId: null }] });
  assert.equal(both.statusCode, 400);
  deps.db.prepare("UPDATE people SET archived = 1 WHERE id = 'p2'").run();
  assert.equal((await send('PUT', '/v1/transactions/t1/splits', 'sp-3', { lines: lines('p2') })).statusCode, 200, 'existing tag stays valid');
  seedPerson(deps.db, { id: 'p3', name: 'Synthetic Moss', archived: true });
  assert.equal((await send('PUT', '/v1/transactions/t1/splits', 'sp-4', { lines: lines('p3') })).statusCode, 400, 'new archived tag refused');
});

test('suggestions: recent untagged deposits, matched by matchText, then name, then one unique amount; Home counts them', async () => {
  const { deps, get } = setup();
  seedPerson(deps.db, { id: 'p3', name: 'Synthetic Moss', matchText: 'VENMO', archived: true });
  const dep = (id: string, date: string, cents: number, desc: string, extra: { plaidCategory?: string; categoryId?: string; personId?: string } = {}) =>
    seedTxn(deps.db, { id, accountId: 'a1', date, amountCents: cents, bankDescription: desc, source: 'plaid', sourceId: id,
      plaidCategory: extra.plaidCategory ?? 'TRANSFER_IN_ACCOUNT_TRANSFER', categoryId: extra.categoryId, personId: extra.personId });
  seedTxn(deps.db, { id: 'lent', accountId: 'a1', date: '2026-03-01', amountCents: -700, personId: 'p2' });
  dep('d1', '2026-03-10', 2500, 'ZELLE FROM SYNTHETIC QUILLON R');
  dep('d2', '2026-03-09', 1200, 'ZELLE FROM SYNTHETIC WREN');
  dep('d3', '2026-03-08', 700, 'VENMO CASHOUT');
  dep('d4', '2026-03-07', 900, 'VENMO CASHOUT');
  dep('x-categorized', '2026-03-06', 500, 'ZELLE FROM SYNTHETIC WREN', { categoryId: 'c-food' });
  dep('x-old', '2026-01-01', 500, 'ZELLE FROM SYNTHETIC WREN');
  dep('x-tagged', '2026-03-05', 300, 'ZELLE FROM SYNTHETIC WREN', { personId: 'p2' });
  dep('x-wages', '2026-03-04', 500, 'PAYROLL', { plaidCategory: 'INCOME_WAGES' });
  dep('x-split', '2026-03-03', 1000, 'VENMO CASHOUT');
  seedSplit(deps.db, { id: '00-a', transactionId: 'x-split', amountCents: 500, categoryId: null, personId: 'p1' });
  seedSplit(deps.db, { id: '01-b', transactionId: 'x-split', amountCents: 500, categoryId: null, personId: 'p2' });
  // balances: p1 = -500 (the x-split repayment line, ahead); p2 = 700 - 300 - 500 = -100 (ahead); nobody owes, so no amount match
  const s = await get('/v1/people/suggestions');
  assert.deepEqual(s.map((x: { transaction: { id: string }; personId: string | null }) => [x.transaction.id, x.personId]),
    [['d1', 'p1'], ['d2', 'p2'], ['d3', null], ['d4', null]], 'd1 by matchText, d2 by name; the archived VENMO matchText is ignored');
  const home = await get('/v1/home');
  assert.equal(home.repaymentSuggestions, 4);
  assert.equal(home.owedToYouCents, 0, 'people who are ahead count as zero');
});

test('an amount matching exactly one person balance or open item is suggested; two matches suggest nobody', async () => {
  const { deps, get } = setup();
  seedTxn(deps.db, { id: 'lent1', accountId: 'a1', date: '2026-03-01', amountCents: -700, personId: 'p1' });
  seedTxn(deps.db, { id: 'cash', accountId: 'a1', date: '2026-03-08', amountCents: 700, bankDescription: 'VENMO CASHOUT', source: 'plaid', sourceId: 'c1',
    plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  assert.deepEqual((await get('/v1/people/suggestions')).map((x: { personId: string | null }) => x.personId), ['p1']);
  assert.equal((await get('/v1/home')).owedToYouCents, 700);
  seedTxn(deps.db, { id: 'lent2', accountId: 'a1', date: '2026-03-02', amountCents: -700, personId: 'p2' });
  assert.deepEqual((await get('/v1/people/suggestions')).map((x: { personId: string | null }) => x.personId), [null]);
});

test('an archived person whose balance reopens stays listed and is never suggested; they can be unarchived', async () => {
  const { deps, get, send } = setup();
  seedTxn(deps.db, { id: 'lent', accountId: 'a1', date: '2026-03-01', amountCents: -3000, personId: 'p1' });
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-05', amountCents: 3000, personId: 'p1', source: 'plaid', sourceId: 'b1' });
  assert.equal((await send('PATCH', '/v1/people/p1', 'ar-1', { archived: true })).statusCode, 200);
  deps.db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id = 'back'").run();
  const listed = (await get('/v1/people')).find((p: { id: string }) => p.id === 'p1');
  assert.deepEqual([listed?.balanceCents, listed?.archived], [3000, true]);
  seedTxn(deps.db, { id: 'dep', accountId: 'a1', date: '2026-03-08', amountCents: 1234, bankDescription: 'ZELLE FROM SYNTHETIC QUILLON R',
    source: 'plaid', sourceId: 'd1', plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  assert.deepEqual((await get('/v1/people/suggestions')).map((x: { personId: string | null }) => x.personId), [null]);
  const un = await send('PATCH', '/v1/people/p1', 'ar-2', { archived: false });
  assert.equal(un.statusCode, 200);
  assert.equal(un.json().archived, false);
});

test('with no non-archived people nothing is suggested', async () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill', archived: true });
  seedTxn(deps.db, { id: 'dep', accountId: 'a1', date: '2026-03-08', amountCents: 500, bankDescription: 'ZELLE FROM SOMEONE',
    source: 'plaid', sourceId: 'd1', plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  const app = buildApp(deps);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  assert.deepEqual(await get('/v1/people/suggestions'), []);
  assert.equal((await get('/v1/home')).repaymentSuggestions, 0);
});
