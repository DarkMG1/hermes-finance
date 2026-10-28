import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { getInboxRow, matchInbox, storeRead } from '../src/inbox.ts';
import { applyPages } from '../src/sync/apply.ts';
import { txn } from './fake-plaid.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedTxn } from './helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
const READ = { items: [], taxCents: 0, tipCents: 0, feesCents: 0, totalCents: 1050, merchant: 'Synthetic Grocer', purchaseDate: '2026-03-10', model: 'fake-model' };
const ID = '0f8c5a7e-1111-4222-8333-944445555666';

function setup() {
  const t = makeTestDeps();
  const { db } = t.deps;
  seedAccount(db, { id: 'card', type: 'credit' });
  seedCategory(db, { id: 'cat-food', name: 'Synthetic Food' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Moss' });
  const app = buildApp(t.deps);
  let n = 0;
  const put = (id: string, body: Buffer = JPEG, type = 'image/jpeg', extra: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: `/v1/receipts/inbox/${id}`, headers: { ...AUTH, 'content-type': type, ...extra }, payload: body });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const post = (url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method: 'POST', url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  const putItems = (id: string, payload: object) =>
    app.inject({ method: 'PUT', url: `/v1/receipts/inbox/${id}/items`, headers: { ...AUTH, 'idempotency-key': `k${(n += 1)}` }, payload });
  const del = (id: string) => app.inject({ method: 'DELETE', url: `/v1/receipts/inbox/${id}`, headers: AUTH });
  return { ...t, db, app, put, get, post, putItems, del };
}

test('inbox route names saved item tags alongside suggestions and a whole-charge For person', async () => {
  const { db, get, putItems, app } = setup();
  db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES ('r1', ?, ?, '2026-03-10T18:00:00.000Z')").run(JPEG, JPEG.length);
  storeRead(db, 'r1', READ, 'now');
  seedTxn(db, { id: 'charge', accountId: 'card', date: '2026-03-10', amountCents: -1050 });
  seedTxn(db, { id: 'other-charge', accountId: 'card', date: '2026-03-11', amountCents: -1050 });
  const saved = await putItems('r1', { items: [{ name: 'Synthetic Pear', amountCents: 1050, people: ['me', 'p1'] }],
    taxCents: 0, tipCents: 0, feesCents: 0 });
  assert.equal(saved.statusCode, 200);
  const waiting = (await get('/v1/receipts/inbox')).json().waiting[0];
  assert.deepEqual(waiting.taggedPersonIds, ['p1']);
  assert.equal(waiting.suggestions.length, 2);
  const set = await app.inject({ method: 'PUT', url: '/v1/receipts/inbox/r1/for',
    headers: { ...AUTH, 'idempotency-key': 'for' }, payload: { personId: 'p1' } });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().forPersonId, 'p1');
  assert.deepEqual(set.json().taggedPersonIds, ['p1']);
  await app.close();
});

test('For-person requires a key, sets and clears only waiting receipts, and replays the original response', async () => {
  const { app, db, get } = setup();
  db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES ('r1', ?, ?, 'now')").run(JPEG, JPEG.length);
  const setFor = (personId: string | null, key?: string, id = 'r1') => app.inject({
    method: 'PUT', url: `/v1/receipts/inbox/${id}/for`, headers: { ...AUTH, ...(key ? { 'idempotency-key': key } : {}) }, payload: { personId },
  });
  assert.equal((await setFor('p1')).json().code, 'IDEMPOTENCY_KEY_REQUIRED');
  const set = await setFor('p1', 'for');
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().forPersonId, 'p1');
  assert.equal((await get('/v1/receipts/inbox')).json().waiting[0].forPersonId, 'p1');
  assert.equal((await setFor(null, 'clear')).json().forPersonId, null);
  assert.deepEqual((await setFor('p1', 'for')).json(), set.json());
  assert.equal(getInboxRow(db, 'r1')!.for_person_id, null, 'replay must not reapply the old value');
  assert.equal((await setFor(null, 'for')).json().code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await setFor('p1', 'missing', 'missing')).statusCode, 404);
  assert.equal((await setFor('p1', 'again')).statusCode, 200);
  seedTxn(db, { id: 'charge', accountId: 'card', date: '2026-03-10', amountCents: -1050 });
  const headers = { ...AUTH, 'idempotency-key': 'link' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/receipts/inbox/r1/link', headers, payload: { transactionId: 'charge' } })).statusCode, 200);
  const linked = (await get('/v1/transactions/charge')).json();
  assert.equal(linked.personId, 'p1', 'a receipt does not need to be read to tag its whole charge');
  assert.deepEqual(linked.splitLines, []);
  assert.equal((await setFor('p1', 'linked')).statusCode, 404);
});

test('For-person rejects unknown, archived and invalid people and its foreign key clears on deletion', async () => {
  const { app, db } = setup();
  db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES ('r1', ?, ?, 'now')").run(JPEG, JPEG.length);
  db.prepare("UPDATE people SET archived = 1 WHERE id = 'p1'").run();
  let n = 0;
  const setFor = (payload: object) => app.inject({ method: 'PUT', url: '/v1/receipts/inbox/r1/for',
    headers: { ...AUTH, 'idempotency-key': `for-${n += 1}` }, payload });
  for (const payload of [{ personId: 'p1' }, { personId: 'missing' }, { personId: '' }, {}, { personId: null, extra: true }]) {
    assert.equal((await setFor(payload)).statusCode, 400);
    assert.equal(getInboxRow(db, 'r1')!.for_person_id, null);
  }
  db.prepare("UPDATE people SET archived = 0 WHERE id = 'p1'").run();
  assert.equal((await setFor({ personId: 'p1' })).statusCode, 200);
  db.prepare("DELETE FROM people WHERE id = 'p1'").run();
  assert.equal(getInboxRow(db, 'r1')!.for_person_id, null);
});

for (const forFirst of [false, true]) test(`For-person and Paid-by creation are mutually exclusive (For first: ${forFirst})`, async () => {
  const { app, db, post } = setup();
  db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES ('r1', ?, ?, 'now')").run(JPEG, JPEG.length);
  const setFor = () => app.inject({ method: 'PUT', url: '/v1/receipts/inbox/r1/for',
    headers: { ...AUTH, 'idempotency-key': 'for' }, payload: { personId: 'p1' } });
  if (forFirst) assert.equal((await setFor()).statusCode, 200);
  const paid = await post('/v1/transactions', { date: '2026-03-10', amountCents: -1050, payee: 'Synthetic Grocer', paidByPersonId: 'p1', inboxReceiptId: 'r1' });
  if (forFirst) {
    assert.deepEqual([paid.statusCode, paid.json().code], [409, 'PAID_BY_PERSON']);
    assert.equal(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get(), 0);
    assert.equal(getInboxRow(db, 'r1')!.linked_at, null);
  } else {
    assert.equal(paid.statusCode, 201);
    assert.equal((await setFor()).statusCode, 404);
    assert.equal(getInboxRow(db, 'r1')!.for_person_id, null);
  }
});

test('upload replies at once, reads in the background, and a retried id changes nothing', async () => {
  const { put, get, reader } = setup();
  const r = await put(ID);
  assert.deepEqual([r.statusCode, r.json()], [200, { id: ID, bytes: JPEG.length }]);
  await settle();
  assert.equal(reader.calls, 1);
  const again = await put(ID, Buffer.from([0xff, 0xd8, 0xff, 9]));
  assert.deepEqual([again.statusCode, again.json().bytes], [200, JPEG.length]);
  await settle();
  assert.equal(reader.calls, 1);
  const list = (await get('/v1/receipts/inbox')).json();
  assert.deepEqual(list.waiting.map((w: { id: string; status: string; merchant: string; totalCents: number }) => [w.id, w.status, w.merchant, w.totalCents]),
    [[ID, 'read', 'Synthetic Grocer', 1050]]);
  assert.deepEqual((await get(`/v1/receipts/inbox/${ID}/photo`)).rawPayload, JPEG);
});

test('upload rejects a non-JPEG, a wrong type and a body over 3 MB', async () => {
  const { put } = setup();
  assert.equal((await put(ID, Buffer.from('nope'))).statusCode, 400);
  assert.equal((await put(ID, JPEG, 'image/png')).statusCode, 415);
  assert.equal((await put(ID, Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]))).statusCode, 413);
});

test('inbox capacity rejects new uploads at 200 while retries and freeing a slot still work', async () => {
  const { db, deps, put, del } = setup();
  deps.receiptReader = null;
  const insert = db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at, read_failed) VALUES (?, ?, ?, 'seed', 1)");
  db.transaction(() => {
    for (let i = 0; i < 199; i += 1) insert.run(`synthetic-${i}`, JPEG, JPEG.length);
  })();
  const responses = await Promise.all([put('synthetic-last'), put('synthetic-overflow')]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const full = responses.find((r) => r.statusCode === 409)!;
  assert.equal(full.json().code, 'INBOX_FULL');
  assert.match(full.json().message, /200 waiting/);
  assert.equal((await put('synthetic-0')).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) FROM inbox_receipts').pluck().get(), 200);
  await del('synthetic-0');
  assert.equal((await put('synthetic-next')).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) FROM inbox_receipts').pluck().get(), 200);
});

test('background and explicit reads share a guard even after the receipt is linked', async () => {
  const { put, post, app, db, reader, deps } = setup();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const original = reader.read.bind(reader);
  reader.read = async () => { started.resolve(); await gate.promise; return original(); };
  await put(ID);
  await started.promise;
  const overlap = await post(`/v1/receipts/inbox/${ID}/read`);
  assert.deepEqual([overlap.statusCode, overlap.json().code], [409, 'READ_IN_PROGRESS']);
  seedTxn(db, { id: 'synthetic-linked', accountId: 'card', date: '2026-03-15', amountCents: -999 });
  assert.equal((await post(`/v1/receipts/inbox/${ID}/link`, { transactionId: 'synthetic-linked' })).statusCode, 200);
  const readLinked = () => app.inject({ method: 'POST', url: '/v1/transactions/synthetic-linked/receipt/read', headers: AUTH });
  assert.equal((await readLinked()).statusCode, 409);
  gate.resolve();
  await settle();
  assert.equal((await readLinked()).statusCode, 200);
  assert.equal((await readLinked()).statusCode, 429);
  assert.equal(reader.calls, 2);
  deps.now = () => new Date('2026-03-15T12:00:30.000Z');
  assert.equal((await readLinked()).statusCode, 200);
});

test('a failed read and no reader both mark the receipt failed; read again recovers', async () => {
  const { put, get, post, reader, deps } = setup();
  reader.next = new Error('boom');
  await put(ID);
  await settle();
  assert.equal((await get('/v1/receipts/inbox')).json().waiting[0].status, 'failed');
  assert.equal((await post(`/v1/receipts/inbox/${ID}/read`)).statusCode, 502);
  assert.equal((await post(`/v1/receipts/inbox/${ID}/read`)).statusCode, 429);
  reader.next = { items: [{ name: 'Synthetic Pear', amountCents: 300 }], taxCents: 0, tipCents: 0, feesCents: 0, totalCents: 300, merchant: null, purchaseDate: null, model: 'fake-model' };
  deps.now = () => new Date('2026-03-15T12:00:30.000Z');
  const ok = await post(`/v1/receipts/inbox/${ID}/read`);
  assert.deepEqual([ok.statusCode, ok.json().status, ok.json().totalCents], [200, 'read', 300]);
  (deps as { receiptReader: unknown }).receiptReader = null;
  const other = '0f8c5a7e-2222-4222-8333-944445555666';
  await put(other);
  await settle();
  assert.equal((await get('/v1/receipts/inbox')).json().waiting.find((w: { id: string }) => w.id === other).status, 'failed');
  assert.equal((await post(`/v1/receipts/inbox/${other}/read`)).statusCode, 503);
});

test('a read that finishes after a hand link stores nothing', async () => {
  const { put, post, db, reader } = setup();
  seedTxn(db, { id: 'c1', accountId: 'card', date: '2026-03-15', amountCents: -999, source: 'plaid', sourceId: 's-c1' });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const original = reader.read.bind(reader);
  reader.read = async () => { await gate; return original(); };
  await put(ID);
  assert.equal((await post(`/v1/receipts/inbox/${ID}/link`, { transactionId: 'c1' })).statusCode, 200);
  release();
  await settle();
  assert.equal(getInboxRow(db, ID)!.read_at, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM receipt_items WHERE transaction_id = 'c1'").get() as { n: number }).n, 0);
});

test('a background read that finishes after tags were saved keeps the tags', async () => {
  const { put, putItems, db, reader } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const original = reader.read.bind(reader);
  reader.read = async () => { await gate; return original(); };
  await put(ID);
  const items = [{ name: 'Synthetic Bread', amountCents: 400, people: ['me', 'p1'] }];
  assert.equal((await putItems(ID, { items, taxCents: 0, tipCents: 0, feesCents: 0 })).statusCode, 200);
  release();
  await settle();
  const row = getInboxRow(db, ID)!;
  assert.equal(row.tagged, 1);
  assert.equal(row.read_at, null);
  assert.deepEqual(JSON.parse(row.items!), items);
});

test('items: save tags, link by hand applies them, the card lists it until dismissed, delete is idempotent', async () => {
  const { put, get, post, putItems, del, db } = setup();
  await put(ID);
  await settle();
  const saved = await putItems(ID, { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }, { name: 'Synthetic Jam', amountCents: 600, people: ['me', 'p1'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().items.map((i: { people: string[] }) => i.people), [['me'], ['me', 'p1']]);
  assert.equal((await putItems(ID, { items: [{ name: 'X', amountCents: 100, people: ['nobody'] }], taxCents: 0, tipCents: 0, feesCents: 0 })).statusCode, 400);
  seedTxn(db, { id: 'c1', accountId: 'card', date: '2026-04-30', amountCents: -1100, source: 'plaid', sourceId: 's-c1' });
  const linked = await post(`/v1/receipts/inbox/${ID}/link`, { transactionId: 'c1' }, 'link-1');
  assert.deepEqual([linked.statusCode, linked.json().splitApplied], [200, true]);
  assert.equal((await post(`/v1/receipts/inbox/${ID}/link`, { transactionId: 'c1' }, 'link-1')).statusCode, 200, 'replayed key');
  assert.equal((await get(`/v1/receipts/inbox/${ID}/photo`)).statusCode, 404);
  assert.equal((await get(`/v1/receipts/inbox/${ID}/items`)).statusCode, 404);
  assert.equal((await get('/v1/receipts/inbox')).json().recentlyLinked.length, 1);
  assert.equal((await post(`/v1/receipts/inbox/${ID}/dismiss`)).statusCode, 204);
  assert.equal((await post(`/v1/receipts/inbox/${ID}/dismiss`)).statusCode, 204);
  assert.equal((await get('/v1/receipts/inbox')).json().recentlyLinked.length, 0);
  assert.equal((await del(ID)).statusCode, 204);
  assert.equal((await del(ID)).statusCode, 204);
  assert.equal((await get('/v1/transactions/c1')).json().hasReceipt, true, 'the receipt stays on the transaction');
});

test('a sync links a waiting receipt, and a pending link follows the posted row', async () => {
  const { put, db, deps } = setup();
  await put(ID);
  await settle();
  seedTxn(db, { id: 'pend', accountId: 'card', date: '2026-03-15', amountCents: -1050, source: 'plaid', sourceId: 'p-pend', pending: true });
  assert.equal(matchInbox(deps), 1);
  assert.equal(getInboxRow(db, ID)!.linked_transaction_id, 'pend');
  db.prepare("UPDATE accounts SET plaid_account_id = 'pa-card' WHERE id = 'card'").run();
  db.transaction(() => applyPages(db, [{ added: [txn({ transactionId: 'posted', pendingTransactionId: 'p-pend', accountId: 'pa-card', amount: 10.5, date: '2026-03-16' })],
    modified: [], removed: [], nextCursor: 'c', hasMore: false }], { itemId: 'item-x', cutoverDate: null, nowIso: '2026-03-16T00:00:00.000Z' }))();
  const postedId = (db.prepare("SELECT id FROM transactions WHERE source_id = 'posted'").get() as { id: string }).id;
  assert.equal(getInboxRow(db, ID)!.linked_transaction_id, postedId);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE transaction_id = ?').get(postedId) as { n: number }).n, 1);
});

test('the capture time comes from x-captured-at when it is sane, otherwise now', async () => {
  const { put, db, deps } = setup();
  const now = deps.now().getTime();
  const earlier = new Date(now - 3 * 86_400_000).toISOString();
  await put(ID, JPEG, 'image/jpeg', { 'x-captured-at': earlier });
  assert.equal(getInboxRow(db, ID)!.captured_at, earlier);
  const other = '0f8c5a7e-3333-4222-8333-944445555666';
  await put(other, JPEG, 'image/jpeg', { 'x-captured-at': new Date(now + 86_400_000).toISOString() });
  assert.equal(getInboxRow(db, other)!.captured_at, new Date(now).toISOString());
  const old = '0f8c5a7e-4444-4222-8333-944445555666';
  await put(old, JPEG, 'image/jpeg', { 'x-captured-at': '2020-01-01T00:00:00.000Z' });
  assert.equal(getInboxRow(db, old)!.captured_at, new Date(now).toISOString());
});

test('read again clears the tags; tags saved while it reads win with 409 CHANGED', async () => {
  const { put, post, putItems, db, reader, deps } = setup();
  await put(ID);
  await settle();
  await putItems(ID, { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me', 'p1'] }], taxCents: 0, tipCents: 0, feesCents: 0 });
  const again = await post(`/v1/receipts/inbox/${ID}/read`);
  assert.deepEqual([again.statusCode, again.json().tagged], [200, false]);
  const items = [{ name: 'Synthetic Jam', amountCents: 600, people: ['p1'] }];
  deps.now = () => new Date('2026-03-15T12:00:30.000Z');
  reader.onRead = () => { db.prepare("UPDATE inbox_receipts SET items = ?, tagged = 1 WHERE id = ?").run(JSON.stringify(items), ID); };
  const raced = await post(`/v1/receipts/inbox/${ID}/read`);
  assert.deepEqual([raced.statusCode, raced.json().code], [409, 'CHANGED']);
  assert.deepEqual(JSON.parse(getInboxRow(db, ID)!.items!), items);
});

test('deleting a linked receipt from its transaction is a real delete: the row stays linked and does not re-link', async () => {
  const { put, post, get, app, db, deps } = setup();
  await put(ID);
  await settle();
  seedTxn(db, { id: 'c1', accountId: 'card', date: '2026-03-15', amountCents: -1050, source: 'plaid', sourceId: 's-c1', bankDescription: 'SYNTHETIC GROCER 01' });
  assert.equal((await post(`/v1/receipts/inbox/${ID}/link`, { transactionId: 'c1' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/transactions/c1/receipt', headers: AUTH })).statusCode, 204);
  const list = (await get('/v1/receipts/inbox')).json();
  assert.deepEqual([list.waiting.length, list.recentlyLinked.length], [0, 0]);
  assert.equal(getInboxRow(db, ID)!.linked_transaction_id, 'c1');
  assert.equal(matchInbox(deps), 0);
});

test('replacing a transaction photo detaches the inbox link', async () => {
  const { put, post, app, db } = setup();
  await put(ID);
  await settle();
  seedTxn(db, { id: 'c1', accountId: 'card', date: '2026-03-15', amountCents: -1050, source: 'plaid', sourceId: 's-c1' });
  await post(`/v1/receipts/inbox/${ID}/link`, { transactionId: 'c1' });
  const r = await app.inject({ method: 'PUT', url: '/v1/transactions/c1/receipt', headers: { ...AUTH, 'content-type': 'image/jpeg' }, payload: JPEG });
  assert.equal(r.statusCode, 200);
  assert.equal(getInboxRow(db, ID)!.linked_transaction_id, null);
});

test('a background read landing on an untagged row during an explicit read is not a conflict', async () => {
  const { put, post, db, reader } = setup();
  await put(ID);
  await settle();
  reader.onRead = () => { storeRead(db, ID, { ...READ, items: [{ name: 'Synthetic Jam', amountCents: 600 }] }, 'now'); };
  const r = await post(`/v1/receipts/inbox/${ID}/read`);
  assert.equal(r.statusCode, 200);
});

test('an inbox reread cannot overwrite concurrent tax, tip or fee saves with unchanged items', async () => {
  for (const field of ['taxCents', 'tipCents', 'feesCents'] as const) {
    const { put, post, putItems, db, reader } = setup();
    await put(ID);
    await settle();
    const body = { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }], taxCents: 0, tipCents: 0, feesCents: 0 };
    assert.equal((await putItems(ID, body)).statusCode, 200);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reading = new Promise<void>((r) => { started = r; });
    reader.read = async () => { started(); await gate; return READ; };
    const pending = post(`/v1/receipts/inbox/${ID}/read`).then((r) => r);
    await reading;
    assert.equal((await putItems(ID, { ...body, [field]: 100 })).statusCode, 200);
    const saved = getInboxRow(db, ID)!;
    release();
    const response = await pending;
    assert.deepEqual([response.statusCode, response.json().code], [409, 'CHANGED'], field);
    assert.deepEqual(getInboxRow(db, ID), saved);
  }
});

test('all recently linked receipts can be listed and dismissed in one pass', async () => {
  const { db, deps, post, get } = setup();
  for (let i = 0; i < 21; i += 1) {
    seedTxn(db, { id: `charge-${i}`, accountId: 'card', date: '2026-03-10', amountCents: -1050 });
    db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, ?, ?, 'seed')").run(`charge-${i}`, JPEG, JPEG.length);
    db.prepare('INSERT INTO inbox_receipts (id, bytes, captured_at, linked_at, linked_transaction_id) VALUES (?, ?, ?, ?, ?)')
      .run(`receipt-${i}`, JPEG.length, deps.now().toISOString(), deps.now().toISOString(), `charge-${i}`);
  }
  const linked = (await get('/v1/receipts/inbox')).json().recentlyLinked as { id: string }[];
  assert.equal(linked.length, 21);
  for (const row of linked) assert.equal((await post(`/v1/receipts/inbox/${row.id}/dismiss`)).statusCode, 204);
  assert.deepEqual((await get('/v1/receipts/inbox')).json().recentlyLinked, []);
});

test('Paid-by creation links the waiting receipt atomically and replays the saved transaction', async () => {
  const { db, post, get, deps } = setup();
  db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES ('r1', ?, ?, 'now')").run(JPEG, JPEG.length);
  const payload = { date: '2026-03-10', amountCents: -1050, payee: 'Synthetic Grocer', paidByPersonId: 'p1', inboxReceiptId: 'r1' };
  const r = await post('/v1/transactions', payload, 'paid');
  assert.equal(r.statusCode, 201);
  const transaction = r.json();
  assert.equal(transaction.hasReceipt, true);
  assert.equal(getInboxRow(db, 'r1')!.linked_transaction_id, transaction.id);
  assert.equal(matchInbox(deps), 0);
  assert.deepEqual((await post('/v1/transactions', payload, 'paid')).json(), transaction);
  assert.equal((await get('/v1/transactions')).json().transactions.length, 1);
});

test('an auto-linked or deleted receipt cannot leave behind a new Paid-by transaction', async () => {
  for (const linked of [false, true]) {
    const { db, deps, post } = setup();
    if (linked) {
      db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES ('r1', ?, ?, 'now')").run(JPEG, JPEG.length);
      storeRead(db, 'r1', READ, 'now');
      seedTxn(db, { id: 'bank', accountId: 'card', date: '2026-03-10', amountCents: -1050, source: 'plaid', sourceId: 'bank', payee: 'Synthetic Grocer' });
      assert.equal(matchInbox(deps), 1);
    }
    const before = db.prepare('SELECT id FROM transactions').all();
    const r = await post('/v1/transactions', { date: '2026-03-10', amountCents: -1050, payee: 'Synthetic Grocer', paidByPersonId: 'p1', inboxReceiptId: 'r1' });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(db.prepare('SELECT id FROM transactions').all(), before);
  }
});
