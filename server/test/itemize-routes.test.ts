import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { getTransaction } from '../src/ledger.ts';
import { ReaderError } from '../src/receipt-reader.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);

function setup(opts: { reader?: boolean } = {}) {
  const t = makeTestDeps();
  if (opts.reader === false) t.deps.receiptReader = null;
  const { db } = t.deps;
  seedAccount(db, { id: 'card' });
  seedCategory(db, { id: 'cat-food', name: 'Synthetic Food' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedPerson(db, { id: 'p2', name: 'Synthetic Wren' });
  seedTxn(db, { id: 'own', accountId: 'card', date: '2026-03-10', amountCents: -2160, source: 'plaid', sourceId: 's-own', categoryId: 'cat-food' });
  seedTxn(db, { id: 'paid', accountId: 'manual', date: '2026-03-10', amountCents: -1000, categoryId: 'cat-food', payee: 'Synthetic Market', paidByPersonId: 'p1' });
  seedTxn(db, { id: 'refund', accountId: 'card', date: '2026-03-10', amountCents: 500, source: 'plaid', sourceId: 's-refund' });
  seedTxn(db, { id: 'noreceipt', accountId: 'card', date: '2026-03-10', amountCents: -500, source: 'plaid', sourceId: 's-nr' });
  for (const id of ['own', 'paid', 'refund']) {
    db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, ?, ?, 'seed')").run(id, JPEG, JPEG.length);
  }
  const app = buildApp(t.deps);
  let n = 0;
  const read = (id: string) => app.inject({ method: 'POST', url: `/v1/transactions/${id}/receipt/read`, headers: AUTH });
  const items = (id: string) => app.inject({ method: 'GET', url: `/v1/transactions/${id}/receipt/items`, headers: AUTH });
  const save = (id: string, payload: unknown, key = `k${(n += 1)}`) =>
    app.inject({ method: 'PUT', url: `/v1/transactions/${id}/receipt/items`, headers: { ...AUTH, 'idempotency-key': key }, payload: payload as object });
  return { ...t, app, read, items, save };
}

const body = (items: [string, number, string[]][], tax = 0) => ({ items: items.map(([name, amountCents, people]) => ({ name, amountCents, people })), taxCents: tax, tipCents: 0, feesCents: 0 });

test('read stores the items (all mine) and the extras', async () => {
  const { read, items, reader } = setup();
  const r = await read('own');
  assert.equal(r.statusCode, 200);
  const got = r.json();
  assert.deepEqual(got.items.map((i: { name: string; amountCents: number; people: string[] }) => [i.name, i.amountCents, i.people]), [['Synthetic Bread', 400, ['me']], ['Synthetic Jam', 600, ['me']]]);
  assert.equal(got.taxCents, 50);
  assert.equal(got.totalCents, 1050);
  assert.equal(got.readAt, '2026-03-15T12:00:00.000Z');
  assert.equal(got.handEdited, false);
  assert.deepEqual((await items('own')).json(), got);
  assert.equal(reader.calls, 1);
});

test('overlapping transaction reads get 409 and completed rereads have a 30-second cooldown', async () => {
  const { read, reader, deps } = setup();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = reader.read.bind(reader);
  reader.read = async () => { started.resolve(); await gate.promise; return original(); };
  const pending = read('own').then((r) => r);
  await started.promise;
  const overlap = await read('own');
  assert.deepEqual([overlap.statusCode, overlap.json().code], [409, 'READ_IN_PROGRESS']);
  gate.resolve();
  assert.equal((await pending).statusCode, 200);
  for (const time of ['2026-03-15T12:00:00.000Z', '2026-03-15T12:00:29.999Z']) {
    deps.now = () => new Date(time);
    const cooldown = await read('own');
    assert.deepEqual([cooldown.statusCode, cooldown.json().code], [429, 'READ_COOLDOWN']);
    assert.match(cooldown.json().message, /30 seconds/);
  }
  assert.equal(reader.calls, 1);
  assert.equal((await read('paid')).statusCode, 200);
  deps.now = () => new Date('2026-03-15T12:00:30.000Z');
  assert.equal((await read('own')).statusCode, 200);
  assert.equal(reader.calls, 3);
});

test('legacy oversized ledger amounts return a field error when items are applied', async () => {
  const { save, deps } = setup();
  deps.db.prepare("UPDATE transactions SET amount_cents = ? WHERE id = 'own'").run(-1e36);
  const r = await save('own', body([['Synthetic Bread', 10, ['me', 'p1']]]));
  assert.deepEqual([r.statusCode, r.json().field], [400, 'items']);
  assert.equal(deps.db.prepare('SELECT COUNT(*) FROM split_lines').pluck().get(), 0);
});

test('a "they paid" read starts every item as shared by me and the payer', async () => {
  const { read } = setup();
  const got = (await read('paid')).json();
  assert.deepEqual(got.items.map((i: { people: string[] }) => i.people), [['me', 'p1'], ['me', 'p1']]);
});

test('read errors: no receipt, removed, reader off, reader failure; nothing stored', async () => {
  const s = setup();
  assert.equal((await s.read('noreceipt')).statusCode, 404);
  assert.equal((await s.read('missing')).statusCode, 404);
  s.reader.next = new ReaderError('HTTP_529');
  const failed = await s.read('own');
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.json().code, 'READ_FAILED');
  const out = setup();
  out.reader.next = new ReaderError('AI_CREDITS_EXHAUSTED');
  const broke = await out.read('own');
  assert.equal(broke.statusCode, 402);
  assert.equal(broke.json().code, 'AI_CREDITS_EXHAUSTED');
  assert.equal((s.deps.db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get() as { n: number }).n, 0);
  const off = setup({ reader: false });
  const r = await off.read('own');
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, 'READER_NOT_CONFIGURED');
});

test('a receipt deleted during the read answers 404 and stores nothing', async () => {
  const s = setup();
  s.reader.onRead = () => s.deps.db.prepare("DELETE FROM receipts WHERE transaction_id = 'own'").run();
  assert.equal((await s.read('own')).statusCode, 404);
  assert.equal((s.deps.db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get() as { n: number }).n, 0);
});

test('items on a never-read receipt are empty; no receipt is 404', async () => {
  const { items } = setup();
  const r = (await items('own')).json();
  assert.deepEqual(r, { items: [], taxCents: null, tipCents: null, feesCents: null, totalCents: null, readAt: null, handEdited: false });
  assert.equal((await items('noreceipt')).statusCode, 404);
});

test('own purchase: saving splits into my line (owner category) and each person', async () => {
  const { save, items, deps } = setup();
  const r = await save('own', body([['Synthetic Bread', 1000, ['me']], ['Synthetic Jam', 1000, ['p1']]], 160));
  assert.equal(r.statusCode, 200);
  const t = getTransaction(deps.db, 'own', '2026-03-15')!;
  assert.deepEqual(t.splitLines.map((l) => [l.amountCents, l.categoryId, l.personId]), [[-1080, 'cat-food', null], [-1080, null, 'p1']]);
  assert.equal(t.amountCents, -2160);
  const it = (await items('own')).json();
  assert.equal(it.handEdited, false);
  assert.deepEqual(it.items.map((i: { people: string[] }) => i.people), [['me'], ['p1']]);
  assert.equal(it.taxCents, 160);
});

test('own purchase: all mine clears the split and keeps the owner category; one person tags the row', async () => {
  const { save, deps } = setup();
  await save('own', body([['A', 1000, ['me']], ['B', 1000, ['p1']]]));
  await save('own', body([['A', 2000, ['me']]]));
  let t = getTransaction(deps.db, 'own', '2026-03-15')!;
  assert.deepEqual(t.splitLines, []);
  assert.equal(t.categoryId, 'cat-food');
  assert.equal(t.personId, null);
  await save('own', body([['A', 2000, ['p1']]]));
  t = getTransaction(deps.db, 'own', '2026-03-15')!;
  assert.deepEqual(t.splitLines, []);
  assert.equal(t.personId, 'p1');
  assert.equal(t.categoryId, null);
});

test('they paid: saving sets the row to my share', async () => {
  const { save, deps } = setup();
  const r = await save('paid', body([['Synthetic Tofu', 1500, ['me']], ['Synthetic Rice', 2000, ['me', 'p1']], ['Synthetic Fish', 800, ['p1']]]));
  assert.equal(r.statusCode, 200);
  const t = getTransaction(deps.db, 'paid', '2026-03-15')!;
  assert.equal(t.amountCents, -2500);
  assert.equal(t.paidByPersonId, 'p1');
  assert.deepEqual(t.splitLines, []);
});

test('they paid: all theirs (my share zero) or a third person is refused and changes nothing', async () => {
  const { save, deps } = setup();
  const allTheirs = await save('paid', body([['Synthetic Fish', 800, ['p1']]]));
  assert.equal(allTheirs.statusCode, 400);
  const third = await save('paid', body([['Synthetic Fish', 800, ['me', 'p2']]]));
  assert.equal(third.statusCode, 400);
  assert.equal(getTransaction(deps.db, 'paid', '2026-03-15')!.amountCents, -1000);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get() as { n: number }).n, 0);
});

test('save rejects: unknown person, nobody on an item, money in, no receipt', async () => {
  const { save } = setup();
  assert.equal((await save('own', body([['A', 1000, ['ghost']]]))).statusCode, 400);
  assert.equal((await save('own', { ...body([['A', 1000, ['me']]]), items: [{ name: 'A', amountCents: 1000, people: [] }] })).statusCode, 400);
  const refund = await save('refund', body([['A', 500, ['me']]]));
  assert.equal(refund.statusCode, 409);
  assert.equal(refund.json().code, 'NOT_MONEY_OUT');
  assert.equal((await save('noreceipt', body([['A', 500, ['me']]]))).statusCode, 404);
});

test('save is idempotent', async () => {
  const { save } = setup();
  const b = body([['A', 1000, ['me']], ['B', 1160, ['p1']]]);
  const first = await save('own', b, 'same');
  const again = await save('own', b, 'same');
  assert.deepEqual(again.json(), first.json());
});

test('handEdited turns on when the split changes after saving', async () => {
  const { save, items, deps } = setup();
  await save('own', body([['A', 1000, ['me']], ['B', 1160, ['p1']]]));
  deps.db.prepare("UPDATE split_lines SET amount_cents = amount_cents - 100 WHERE transaction_id = 'own' AND person_id IS NULL").run();
  deps.db.prepare("UPDATE split_lines SET amount_cents = amount_cents + 100 WHERE transaction_id = 'own' AND person_id = 'p1'").run();
  assert.equal((await items('own')).json().handEdited, true);
});

test('a person archived after the split was saved can stay on re-save', async () => {
  const { save, deps } = setup();
  await save('own', body([['A', 1000, ['me']], ['B', 1160, ['p1']]]));
  deps.db.prepare("UPDATE people SET archived = 1 WHERE id = 'p1'").run();
  assert.equal((await save('own', body([['A', 900, ['me']], ['B', 1260, ['p1']]]))).statusCode, 200);
});

test('a new or deleted photo clears the items', async () => {
  const { app, read, items, deps } = setup();
  await read('own');
  await app.inject({ method: 'PUT', url: '/v1/transactions/own/receipt', headers: { ...AUTH, 'content-type': 'image/jpeg' }, payload: JPEG });
  assert.deepEqual((await items('own')).json().items, []);
  assert.equal((await items('own')).json().readAt, null);
  deps.now = () => new Date('2026-03-15T12:00:30.000Z');
  assert.equal((await read('own')).statusCode, 200);
  await app.inject({ method: 'DELETE', url: '/v1/transactions/own/receipt', headers: AUTH });
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get() as { n: number }).n, 0);
});

test('items go when the transaction is deleted', async () => {
  const { read, deps } = setup();
  await read('paid');
  deps.db.prepare("DELETE FROM transactions WHERE id = 'paid'").run();
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get() as { n: number }).n, 0);
});

test('a pending row can be itemized', async () => {
  const { save, deps } = setup();
  seedTxn(deps.db, { id: 'pend', accountId: 'card', date: '2026-03-14', amountCents: -2000, source: 'plaid', sourceId: 's-pend', pending: true });
  deps.db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('pend', ?, 5, 'seed')").run(JPEG);
  assert.equal((await save('pend', body([['A', 1000, ['me']], ['B', 1000, ['p2']]]))).statusCode, 200);
  assert.equal(getTransaction(deps.db, 'pend', '2026-03-15')!.splitLines.length, 2);
});

test('an existing split keeps its owner category from the first line without a person', async () => {
  const { save, deps } = setup();
  deps.db.prepare("UPDATE transactions SET category_id = NULL WHERE id = 'own'").run();
  seedSplit(deps.db, { id: 'l1', transactionId: 'own', amountCents: -1160, categoryId: 'cat-food' });
  seedSplit(deps.db, { id: 'l2', transactionId: 'own', amountCents: -1000, categoryId: null, personId: 'p1' });
  await save('own', body([['A', 1080, ['me']], ['B', 1080, ['p2']]]));
  assert.deepEqual(getTransaction(deps.db, 'own', '2026-03-15')!.splitLines.map((l) => [l.categoryId, l.personId]), [['cat-food', null], [null, 'p2']]);
});

test('a photo replaced during the read answers 409 and stores nothing', async () => {
  const s = setup();
  s.reader.onRead = () => s.deps.db.prepare("UPDATE receipts SET created_at = 'replaced' WHERE transaction_id = 'own'").run();
  const r = await s.read('own');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'RECEIPT_CHANGED');
  assert.equal((s.deps.db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get() as { n: number }).n, 0);
  assert.equal((await s.items('own')).json().readAt, null);
});

test('reading money in is refused before the reader runs', async () => {
  const { read, reader } = setup();
  const r = await read('refund');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'NOT_MONEY_OUT');
  assert.equal(reader.calls, 0);
});

test('a share that rounds to zero cents is refused', async () => {
  const { save, deps } = setup();
  deps.db.prepare("UPDATE transactions SET amount_cents = -5 WHERE id = 'own'").run();
  const r = await save('own', body([['A', 1000, ['me']], ['B', 100, ['p1']]]));
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /each person's share must be more than zero/);
});

test('all mine with no owner category leaves the bank category free; one person still marks it owner-set', async () => {
  const { save, deps } = setup();
  deps.db.prepare("UPDATE transactions SET category_id = NULL WHERE id = 'own'").run();
  const ownerSet = () => (deps.db.prepare("SELECT category_owner_set AS s FROM transactions WHERE id = 'own'").get() as { s: number }).s;
  await save('own', body([['A', 2160, ['me']]]));
  assert.equal(ownerSet(), 0);
  await save('own', body([['A', 2160, ['p1']]]));
  assert.equal(ownerSet(), 1);
});

test('they paid: handEdited turns on when the amount changes after saving', async () => {
  const { save, items, deps } = setup();
  await save('paid', body([['A', 1000, ['me']], ['B', 1000, ['p1']]]));
  assert.equal((await items('paid')).json().handEdited, false);
  deps.db.prepare("UPDATE transactions SET amount_cents = -900 WHERE id = 'paid'").run();
  assert.equal((await items('paid')).json().handEdited, true);
});

test('saving items on a removed transaction is 404', async () => {
  const { save, deps } = setup();
  deps.db.prepare("UPDATE transactions SET removed_at = '2026-03-14T00:00:00.000Z' WHERE id = 'own'").run();
  assert.equal((await save('own', body([['A', 2160, ['me']]]))).statusCode, 404);
});

test('a hand save without a read leaves readAt null', async () => {
  const { save, items } = setup();
  await save('own', body([['A', 2160, ['me']]]));
  assert.equal((await items('own')).json().readAt, null);
});

test('a transaction reread rejects concurrent item, extra, split or payer changes', async () => {
  for (const change of ['items', 'extras', 'split', 'payer', 'edited split']) {
    const { read, save, items, deps, reader } = setup();
    const { db } = deps;
    await read('own');
    deps.now = () => new Date('2026-03-15T12:00:30.000Z');
    if (change === 'edited split') {
      await save('own', body([['Synthetic Bread', 2160, ['me', 'p1']]]));
      db.prepare("UPDATE split_lines SET amount_cents = amount_cents - 1 WHERE transaction_id = 'own' AND person_id IS NULL").run();
      assert.equal((await items('own')).json().handEdited, true);
    }
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reading = new Promise<void>((r) => { started = r; });
    const original = reader.read.bind(reader);
    reader.read = async () => { started(); await gate; return original(); };
    const id = change === 'payer' ? 'paid' : 'own';
    const pending = read(id).then((r) => r);
    await reading;
    if (change === 'payer') db.prepare("UPDATE transactions SET paid_by_person_id = 'p2' WHERE id = 'paid'").run();
    else if (change === 'edited split') db.prepare("UPDATE split_lines SET amount_cents = amount_cents - 1 WHERE transaction_id = 'own' AND person_id IS NULL").run();
    else {
      assert.equal((await save('own', body([['Synthetic Bread', 1000, ['me']], ['Synthetic Jam', 1000, ['p1']]], 160))).statusCode, 200);
      if (change === 'extras') assert.equal((await save('own', { ...body([['Synthetic Bread', 1000, ['me']], ['Synthetic Jam', 1000, ['p1']]], 160), tipCents: 100 })).statusCode, 200);
      if (change === 'split') db.prepare("UPDATE split_lines SET amount_cents = amount_cents - 1 WHERE transaction_id = 'own' AND person_id IS NULL").run();
    }
    const saved = (await items(id)).json();
    release();
    const r = await pending;
    assert.deepEqual([r.statusCode, r.json().code], [409, 'CHANGED'], change);
    assert.deepEqual((await items(id)).json(), saved, change);
  }
});
