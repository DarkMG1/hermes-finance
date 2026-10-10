import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { makeTestDeps, AUTH, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1', subtype: 'checking' });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill', matchText: 'SYNTHETIC QUILLON' });
  seedPerson(deps.db, { id: 'p2', name: 'Synthetic Wren' });
  const app = buildApp(deps);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const send = (method: 'POST' | 'PATCH' | 'PUT', url: string, key: string, payload: object) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, payload });
  return { deps, app, get, send };
}

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

test('suggestions come only from checking deposits, and show even before anyone is added', async () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1', subtype: 'checking' });
  seedAccount(deps.db, { id: 'card', type: 'credit', subtype: 'credit card' });
  seedAccount(deps.db, { id: 'sav', subtype: 'savings' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill', archived: true });
  const dep = (id: string, accountId: string, desc: string) => seedTxn(deps.db, { id, accountId, date: '2026-03-08', amountCents: 500,
    bankDescription: desc, source: 'plaid', sourceId: id, plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  dep('dep', 'a1', 'ZELLE FROM SOMEONE');
  dep('card-payment', 'card', 'SYNTHETIC CARD PAYMENT');
  dep('sav-in', 'sav', 'TRANSFER FROM CHECKING');
  const app = buildApp(deps);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  assert.deepEqual((await get('/v1/people/suggestions')).map((x: { transaction: { id: string }; personId: string | null }) =>
    [x.transaction.id, x.personId]), [['dep', null]]);
  assert.equal((await get('/v1/home')).repaymentSuggestions, 1);
});

test('a dismissed deposit is never suggested again; dismissing an unknown row is 404', async () => {
  const { deps, get, send } = setup();
  seedTxn(deps.db, { id: 'dep', accountId: 'a1', date: '2026-03-08', amountCents: 500, bankDescription: 'ZELLE FROM SOMEONE',
    source: 'plaid', sourceId: 'd1', plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  assert.equal((await get('/v1/people/suggestions')).length, 1);
  assert.equal((await send('POST', '/v1/people/suggestions/dep/dismiss', 'ds-1', {})).statusCode, 200);
  assert.deepEqual(await get('/v1/people/suggestions'), []);
  assert.equal((await get('/v1/home')).repaymentSuggestions, 0);
  assert.equal((await send('POST', '/v1/people/suggestions/nope/dismiss', 'ds-2', {})).statusCode, 404);
});

test('a chosen repayment account replaces the checking default; clearing it restores the default', async () => {
  const { deps, get, send } = setup();
  seedAccount(deps.db, { id: 'cash', subtype: 'checking' });
  seedAccount(deps.db, { id: 'other' });
  const dep = (id: string, accountId: string) => seedTxn(deps.db, { id, accountId, date: '2026-03-08', amountCents: 500,
    bankDescription: 'ZELLE FROM SOMEONE', source: 'plaid', sourceId: id, plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  dep('in-a1', 'a1');
  dep('in-cash', 'cash');
  dep('in-other', 'other');
  const ids = async () => (await get('/v1/people/suggestions')).map((x: { transaction: { id: string } }) => x.transaction.id).sort();
  assert.deepEqual(await get('/v1/people/settings'), { repaymentAccountId: null });
  assert.deepEqual(await ids(), ['in-a1', 'in-cash'], 'unset: every checking account');
  const set = await send('PUT', '/v1/people/settings', 'st-1', { repaymentAccountId: 'a1' });
  assert.deepEqual([set.statusCode, set.json()], [200, { repaymentAccountId: 'a1' }]);
  assert.deepEqual(await ids(), ['in-a1']);
  assert.equal((await send('PUT', '/v1/people/settings', 'st-2', { repaymentAccountId: 'nope' })).statusCode, 400);
  seedAccount(deps.db, { id: 'card', type: 'credit', subtype: 'credit card' });
  assert.equal((await send('PUT', '/v1/people/settings', 'st-4', { repaymentAccountId: 'card' })).statusCode, 400, 'repayments land in a bank account');
  assert.equal((await send('PUT', '/v1/people/settings', 'st-3', { repaymentAccountId: null })).statusCode, 200);
  assert.deepEqual(await ids(), ['in-a1', 'in-cash']);
});

test('they paid: a manual row with a payer; create, edit, switch from For, refuse bank, split and archived payers', async () => {
  const { deps, send } = setup();
  const created = await send('POST', '/v1/transactions', 'tp-1',
    { date: '2026-03-03', amountCents: -6000, payee: 'Synthetic Market', categoryId: 'c-food', paidByPersonId: 'p1' });
  assert.equal(created.statusCode, 201);
  const t = created.json();
  assert.deepEqual([t.paidByPersonId, t.personId, t.categoryId, t.repaymentDismissed], ['p1', null, 'c-food', false]);
  assert.equal((await send('POST', '/v1/transactions', 'tp-2', { date: '2026-03-03', amountCents: 6000, payee: 'X', paidByPersonId: 'p1' })).statusCode,
    400, 'a payer covers money out');
  assert.equal((await send('POST', '/v1/transactions', 'tp-3', { date: '2026-03-03', amountCents: -100, payee: 'X', paidByPersonId: 'nope' })).statusCode, 400);

  const recat = await send('PATCH', `/v1/transactions/${t.id}`, 'tp-4', { categoryId: null });
  assert.deepEqual([recat.statusCode, recat.json().paidByPersonId, recat.json().personId], [200, 'p1', null], 'editing keeps the payer');
  assert.equal((await send('PATCH', `/v1/transactions/${t.id}`, 'tp-5', { personId: 'p2' })).statusCode, 400, 'a payer row is never tagged');
  assert.equal((await send('PATCH', `/v1/transactions/${t.id}`, 'tp-6', { personId: 'p2', paidByPersonId: 'p1' })).statusCode, 400);
  assert.equal((await send('PATCH', `/v1/transactions/${t.id}`, 'tp-7', { paidByPersonId: 'p2' })).json().paidByPersonId, 'p2');

  const forRow = (await send('POST', '/v1/transactions', 'tp-8', { date: '2026-03-04', amountCents: -800, payee: 'Synthetic Lamp' })).json();
  await send('PATCH', `/v1/transactions/${forRow.id}`, 'tp-9', { personId: 'p1' });
  const switched = await send('PATCH', `/v1/transactions/${forRow.id}`, 'tp-10', { personId: null, paidByPersonId: 'p1' });
  assert.deepEqual([switched.statusCode, switched.json().personId, switched.json().paidByPersonId], [200, null, 'p1'], 'For → Paid by in one PATCH');

  const split = await send('PUT', `/v1/transactions/${t.id}/splits`, 'tp-11',
    { lines: [{ amountCents: -3000, categoryId: null }, { amountCents: -3000, categoryId: null }] });
  assert.deepEqual([split.statusCode, split.json().code], [409, 'PAID_BY_PERSON']);
  const s = (await send('POST', '/v1/transactions', 'tp-12', { date: '2026-03-05', amountCents: -1000, payee: 'Synthetic Split' })).json();
  await send('PUT', `/v1/transactions/${s.id}/splits`, 'tp-13', { lines: [{ amountCents: -500, categoryId: null }, { amountCents: -500, categoryId: null }] });
  assert.equal((await send('PATCH', `/v1/transactions/${s.id}`, 'tp-14', { paidByPersonId: 'p1' })).json().code, 'SPLIT_TRANSACTION');
  seedTxn(deps.db, { id: 'bank', accountId: 'a1', date: '2026-03-03', amountCents: -500, source: 'plaid', sourceId: 'b1' });
  const bank = await send('PATCH', '/v1/transactions/bank', 'tp-15', { paidByPersonId: 'p1' });
  assert.deepEqual([bank.statusCode, bank.json().code], [409, 'BANK_TRANSACTION']);
  const income = (await send('POST', '/v1/transactions', 'tp-16', { date: '2026-03-05', amountCents: 900, payee: 'Synthetic Refund' })).json();
  assert.equal((await send('PATCH', `/v1/transactions/${income.id}`, 'tp-17', { paidByPersonId: 'p1' })).statusCode, 400);

  deps.db.prepare("UPDATE people SET archived = 1 WHERE id = 'p2'").run();
  assert.equal((await send('PATCH', `/v1/transactions/${t.id}`, 'tp-18', { notes: 'still fine' })).statusCode, 200);
  assert.equal((await send('PATCH', `/v1/transactions/${t.id}`, 'tp-19', { paidByPersonId: 'p2' })).statusCode, 200,
    'an archived payer already on the row stays valid');
  assert.equal((await send('PATCH', `/v1/transactions/${forRow.id}`, 'tp-20', { paidByPersonId: 'p2' })).statusCode, 400,
    'a new archived payer is refused');
});

test('a dismissed suggestion can be restored through the transaction', async () => {
  const { deps, get, send } = setup();
  seedTxn(deps.db, { id: 'dep', accountId: 'a1', date: '2026-03-08', amountCents: 500, bankDescription: 'ZELLE FROM SOMEONE',
    source: 'plaid', sourceId: 'd1', plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  await send('POST', '/v1/people/suggestions/dep/dismiss', 'ud-1', {});
  assert.equal((await get('/v1/transactions/dep')).repaymentDismissed, true);
  const restored = await send('PATCH', '/v1/transactions/dep', 'ud-2', { repaymentDismissed: false });
  assert.deepEqual([restored.statusCode, restored.json().repaymentDismissed], [200, false]);
  assert.equal((await get('/v1/people/suggestions')).length, 1);
});

test('the feed: each entry with its effect and the balance after it, newest first, settled where it reaches 0', async () => {
  const { deps, get } = setup();
  seedTxn(deps.db, { id: 'supplies', accountId: 'a1', date: '2026-03-01', amountCents: -4000 });
  seedSplit(deps.db, { id: '00-a', transactionId: 'supplies', amountCents: -2000, categoryId: 'c-food' });
  seedSplit(deps.db, { id: '01-b', transactionId: 'supplies', amountCents: -2000, categoryId: null, personId: 'p1' });
  seedTxn(deps.db, { id: 'groceries', accountId: 'manual', date: '2026-03-03', amountCents: -6000, categoryId: 'c-food', paidByPersonId: 'p1' });
  seedTxn(deps.db, { id: 'settle', accountId: 'a1', date: '2026-03-31', amountCents: -4000, personId: 'p1', source: 'plaid', sourceId: 'v1' });
  seedTxn(deps.db, { id: 'zelle', accountId: 'a1', date: '2026-04-02', amountCents: 1500, personId: 'p1', source: 'plaid', sourceId: 'z1' });
  const d = await get('/v1/people/p1');
  assert.equal(d.person.balanceCents, -1500);
  assert.deepEqual(d.history.map((h: { transactionId: string; lineId: string | null; kind: string; effectCents: number;
    balanceAfterCents: number; settled: boolean }) => [h.transactionId, h.lineId, h.kind, h.effectCents, h.balanceAfterCents, h.settled]), [
    ['zelle', null, 'fromThem', -1500, -1500, false],
    ['settle', null, 'forThem', 4000, 0, true],
    ['groceries', null, 'paidByThem', -6000, -4000, false],
    ['supplies', '01-b', 'forThem', 2000, 2000, false],
  ]);
  assert.equal((await get('/v1/spending?period=month&date=2026-03')).totalCents, 8000, 'my half of supplies plus my share of groceries');
  const home = await get('/v1/home');
  assert.deepEqual([home.owedToYouCents, home.youOweCents], [0, 1500]);
  deps.db.prepare("DELETE FROM transactions WHERE id = 'groceries'").run();
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 4500, 'a deleted they-paid row leaves balance and feed');
  deps.db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id = 'settle'").run();
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 500);
  assert.equal((await get('/v1/people/nope')).code, 'NOT_FOUND');
});

test('people come owed-to-you first, then people you owe, then settled', async () => {
  const { deps, get } = setup();
  seedPerson(deps.db, { id: 'p3', name: 'Synthetic Moss' });
  seedPerson(deps.db, { id: 'p4', name: 'Synthetic Fern' });
  seedTxn(deps.db, { id: 'a', accountId: 'a1', date: '2026-03-01', amountCents: -500, personId: 'p2' });
  seedTxn(deps.db, { id: 'b', accountId: 'manual', date: '2026-03-01', amountCents: -900, categoryId: 'c-food', paidByPersonId: 'p3' });
  seedTxn(deps.db, { id: 'c', accountId: 'manual', date: '2026-03-01', amountCents: -100, categoryId: 'c-food', paidByPersonId: 'p1' });
  assert.deepEqual((await get('/v1/people')).map((p: { id: string; balanceCents: number }) => [p.id, p.balanceCents]),
    [['p2', 500], ['p3', -900], ['p1', -100], ['p4', 0]]);
  const home = await get('/v1/home');
  assert.deepEqual([home.owedToYouCents, home.youOweCents], [500, 1000]);
});

test('a hidden repayment account falls back to every checking account', async () => {
  const { deps, get, send } = setup();
  seedAccount(deps.db, { id: 'cash', subtype: 'checking' });
  const dep = (id: string, accountId: string) => seedTxn(deps.db, { id, accountId, date: '2026-03-08', amountCents: 500,
    bankDescription: 'ZELLE FROM SOMEONE', source: 'plaid', sourceId: id, plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER' });
  dep('in-a1', 'a1');
  dep('in-cash', 'cash');
  const ids = async () => (await get('/v1/people/suggestions')).map((x: { transaction: { id: string } }) => x.transaction.id).sort();
  await send('PUT', '/v1/people/settings', 'hf-1', { repaymentAccountId: 'cash' });
  assert.deepEqual(await ids(), ['in-cash']);
  deps.db.prepare("UPDATE accounts SET hidden = 1 WHERE id = 'cash'").run();
  assert.deepEqual(await ids(), ['in-a1', 'in-cash']);
});
