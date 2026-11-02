import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, entryKey, type Tagged, type Link } from '../src/ious.ts';
import { buildApp } from '../src/app.ts';
import { fitSplitToAmount } from '../src/ledger.ts';
import { applyItems } from '../src/itemize.ts';
import { makeTestDeps, AUTH, seedAccount, seedPerson, seedSplit, seedTxn } from './helpers.ts';

let n = 0;
const e = (id: string, amount: number, o: Partial<Tagged> = {}): Tagged => ({
  person_id: 'p1', transaction_id: id, line_id: null, date: `2026-03-${String(10 + n).padStart(2, '0')}`, payee: id.toUpperCase(),
  amount, paid_by: 0, created_at: `2026-03-01T00:00:${String(n++).padStart(2, '0')}Z`, row_order: n, forgiven: 0, ...o,
});
const l = (payback: string, item: string, cents: number, at = '2026-04-01T00:00:00Z', o: Partial<Link> = {}): Link => ({
  id: `${payback}>${item}`, payback_transaction_id: payback, payback_line_id: null, item_transaction_id: item, item_line_id: null,
  amount_cents: cents, created_at: at, ...o,
});
const left = (s: ReturnType<typeof settle>) => Object.fromEntries([...s.items].map(([k, v]) => [k.split('|')[0], v.leftCents]));
const balance = (es: Tagged[]) => -es.reduce((s, x) => s + x.amount, 0);

test('unlinked paybacks settle the oldest items first', () => {
  const es = [e('dinner', -3000), e('concert', -6000), e('back', 4000)];
  assert.deepEqual(left(settle(es, [])), { dinner: 0, concert: 5000 });
});

test('a linked payback pays its item, the rest settles the oldest', () => {
  const es = [e('dinner', -3000), e('concert', -6000), e('back', 7000)];
  const s = settle(es, [l('back', 'concert', 6000)]);
  assert.deepEqual(left(s), { dinner: 2000, concert: 0 });
  assert.deepEqual(s.items.get(entryKey('concert', null))!.paybacks, [{ transactionId: 'back', lineId: null, date: es[2]!.date, amountCents: 6000 }]);
  assert.deepEqual(s.paidBack.get(entryKey('back', null)), [{ transactionId: 'concert', lineId: null, amountCents: 6000 }]);
});

test('partial and multi-item links', () => {
  const es = [e('a', -1000), e('b', -2000), e('c', -3000), e('back', 2500)];
  const s = settle(es, [l('back', 'c', 2000, '2026-04-01T00:00:00Z'), l('back', 'b', 500, '2026-04-02T00:00:00Z')]);
  assert.deepEqual(left(s), { a: 1000, b: 1500, c: 1000 });
});

test('links are capped by what the payback and the item have left after bank edits', () => {
  // the bank shrank the payback to 1500 and the item to 1000 after the owner linked 2000
  const es = [e('old', -4000), e('item', -1000), e('back', 1500)];
  const s = settle(es, [l('back', 'item', 2000)]);
  assert.deepEqual(left(s), { old: 3500, item: 0 }, 'link applies 1000 (item cap); the other 500 settles the oldest');
});

test('links to entries that are not this person\'s live items are ignored', () => {
  const es = [e('item', -1000), e('back', 1000)];
  assert.deepEqual(left(settle(es, [l('back', 'gone', 1000), l('gone-back', 'item', 1000)])), { item: 0 }, 'unlinked FIFO still settles it');
});

test('forgiveness lines and paid-by-them rows settle the oldest items (R1)', () => {
  const es = [e('a', -2000), e('b', -2000), e('forgave', 1000, { forgiven: 1 }), e('theypaid', 1500, { paid_by: 1 })];
  assert.deepEqual(left(settle(es, [])), { a: 0, b: 1500 });
});

test('paid-by and forgiven rows are never items and never carry links', () => {
  const es = [e('item', -1000), e('theypaid', 500, { paid_by: 1 })];
  const s = settle(es, [l('theypaid', 'item', 500)]);
  assert.equal(s.paidBack.get(entryKey('theypaid', null)), undefined);
  assert.equal(s.items.get(entryKey('item', null))!.paybacks.length, 0);
});

test('split lines are keyed by line', () => {
  const es = [e('t1', -2500, { line_id: 'L1' }), e('back', 2500)];
  const s = settle(es, [l('back', 't1', 2500, undefined, { item_line_id: 'L1' })]);
  assert.equal(s.items.get(entryKey('t1', 'L1'))!.leftCents, 0);
});

test('two paybacks linked to one item: the earlier is applied first, the later is capped and its rest settles the oldest other item', () => {
  const es = [e('old', -2000), e('item', -3000), e('b1', 2000), e('b2', 2000)];
  const s = settle(es, [l('b1', 'item', 2000), l('b2', 'item', 2000)]);
  assert.deepEqual(left(s), { old: 1000, item: 0 });
  assert.deepEqual(s.items.get(entryKey('item', null))!.paybacks.map((p) => [p.transactionId, p.amountCents]), [['b1', 2000], ['b2', 1000]]);
});

test('invariant on random synthetic ledgers: sum of left = max(balance, 0), never negative', () => {
  let seed = 7;
  const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % k; };
  for (let run = 0; run < 300; run++) {
    const es: Tagged[] = [];
    for (let i = 0; i < 1 + rnd(12); i++) {
      const kind = rnd(5);
      const cents = 100 + rnd(9000);
      es.push(e(`r${run}-${i}`, kind < 3 ? -cents : cents, { paid_by: kind === 4 ? 1 : 0, forgiven: kind === 3 && rnd(4) === 0 ? 1 : 0 }));
    }
    const items = es.filter((x) => x.amount < 0);
    const backs = es.filter((x) => x.amount > 0 && !x.paid_by && !x.forgiven);
    const links: Link[] = [];
    for (const b of backs) for (const it of items) if (rnd(3) === 0) links.push(l(b.transaction_id, it.transaction_id, 1 + rnd(12000)));
    const s = settle(es, links);
    const lefts = [...s.items.values()].map((v) => v.leftCents);
    assert.ok(lefts.every((x) => x >= 0));
    assert.equal(lefts.reduce((a, b) => a + b, 0), Math.max(balance(es), 0), `run ${run}`);
  }
});

function app() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1', subtype: 'checking' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  const a = buildApp(deps);
  const get = async (url: string) => (await a.inject({ method: 'GET', url, headers: AUTH })).json();
  const link = (id: string, payback: string, item: string, cents: number, itemLine: string | null = null) => deps.db.prepare(
    'INSERT INTO iou_links (id, payback_transaction_id, payback_line_id, item_transaction_id, item_line_id, amount_cents, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
    .run(id, payback, item, itemLine, cents, '2026-04-01T00:00:00Z');
  return { deps, get, link, send: (method: 'PUT' | 'PATCH', url: string, key: string, payload: object) =>
    a.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, payload }) };
}

test('person detail lists open items oldest first, with left, totals and linked paybacks; history carries leftCents and paidBack', async () => {
  const { deps, get, link } = app();
  seedTxn(deps.db, { id: 'dinner', accountId: 'a1', date: '2026-03-01', amountCents: -3000, personId: 'p1', payee: 'SYNTHETIC DINNER' });
  seedTxn(deps.db, { id: 'concert', accountId: 'a1', date: '2026-03-02', amountCents: -6000, personId: 'p1', payee: 'SYNTHETIC CONCERT' });
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-05', amountCents: 2000, personId: 'p1' });
  link('k1', 'back', 'concert', 2000);
  const d = await get('/v1/people/p1');
  assert.deepEqual(d.openItems.map((i: { transactionId: string; leftCents: number; totalCents: number }) => [i.transactionId, i.leftCents, i.totalCents]),
    [['dinner', 3000, 3000], ['concert', 4000, 6000]]);
  assert.deepEqual(d.openItems[1].paybacks, [{ transactionId: 'back', lineId: null, date: '2026-03-05', amountCents: 2000 }]);
  const h = Object.fromEntries(d.history.map((x: { transactionId: string }) => [x.transactionId, x]));
  assert.equal(h.concert.leftCents, 4000);
  assert.deepEqual(h.back.paidBack, [{ transactionId: 'concert', lineId: null, amountCents: 2000 }]);
  assert.equal(h.dinner.paidBack, undefined);
  assert.equal(d.person.balanceCents, 7000, 'balance unchanged by links');
});

test('transaction iou: item left, payback paidBack with payees, null on split and untagged rows', async () => {
  const { deps, get, link } = app();
  seedTxn(deps.db, { id: 'concert', accountId: 'a1', date: '2026-03-02', amountCents: -6000, personId: 'p1', payee: 'SYNTHETIC CONCERT' });
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-05', amountCents: 6000, personId: 'p1' });
  seedTxn(deps.db, { id: 'split', accountId: 'a1', date: '2026-03-06', amountCents: -2000 });
  seedSplit(deps.db, { id: 'L1', transactionId: 'split', amountCents: -1000, categoryId: null, personId: 'p1' });
  seedSplit(deps.db, { id: 'L2', transactionId: 'split', amountCents: -1000, categoryId: null });
  seedTxn(deps.db, { id: 'mine', accountId: 'a1', date: '2026-03-07', amountCents: -500 });
  link('k1', 'back', 'concert', 6000);
  assert.deepEqual((await get('/v1/transactions/concert')).iou, { leftCents: 0, paidBack: [] });
  assert.deepEqual((await get('/v1/transactions/back')).iou, { leftCents: null, paidBack: [{ transactionId: 'concert', lineId: null, amountCents: 6000, payee: 'SYNTHETIC CONCERT' }] });
  assert.equal((await get('/v1/transactions/split')).iou, null);
  assert.equal((await get('/v1/transactions/mine')).iou, null);
  const page = await get('/v1/transactions?personId=p1');
  assert.deepEqual(page.transactions.find((t: { id: string }) => t.id === 'concert').iou, { leftCents: 0, paidBack: [] }, 'lists carry it too');
});

test('PUT payback tags the deposit, clears its category, links items; GET offers open items without this payback', async () => {
  const { deps, get, send } = app();
  seedTxn(deps.db, { id: 'dinner', accountId: 'a1', date: '2026-03-01', amountCents: -3000, personId: 'p1' });
  seedTxn(deps.db, { id: 'concert', accountId: 'a1', date: '2026-03-02', amountCents: -6000, personId: 'p1' });
  seedTxn(deps.db, { id: 'dep', accountId: 'a1', date: '2026-03-05', amountCents: 6000 });
  const choices = await get('/v1/transactions/dep/payback?personId=p1');
  assert.deepEqual(choices.items.map((i: { transactionId: string }) => i.transactionId), ['dinner', 'concert']);
  assert.deepEqual(choices.linked, []);
  const r = await send('PUT', '/v1/transactions/dep/payback', 'pb-1', { personId: 'p1', items: [{ transactionId: 'concert', amountCents: 6000 }] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().personId, r.json().categoryId], ['p1', null]);
  assert.deepEqual((await get('/v1/people/p1')).openItems.map((i: { transactionId: string }) => i.transactionId), ['dinner']);
  // editing: the item this payback closed is offered again in full (R2)
  const again = await get('/v1/transactions/dep/payback?personId=p1');
  assert.deepEqual(again.items.map((i: { transactionId: string; leftCents: number }) => [i.transactionId, i.leftCents]), [['dinner', 3000], ['concert', 6000]]);
  assert.deepEqual(again.linked, [{ transactionId: 'concert', lineId: null, amountCents: 6000 }]);
  // replace with "just the balance"
  assert.equal((await send('PUT', '/v1/transactions/dep/payback', 'pb-2', { personId: 'p1', items: [] })).statusCode, 200);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM iou_links').get() as { n: number }).n, 0);
});

test('PUT payback validation: other person, closed item, over item, over payback, duplicate, money out, split without line, forgiven', async () => {
  const { deps, send } = app();
  seedPerson(deps.db, { id: 'p2', name: 'Synthetic Wren' });
  seedTxn(deps.db, { id: 'mine', accountId: 'a1', date: '2026-03-01', amountCents: -1000, personId: 'p1' });
  seedTxn(deps.db, { id: 'theirs', accountId: 'a1', date: '2026-03-01', amountCents: -1000, personId: 'p2' });
  seedTxn(deps.db, { id: 'paid', accountId: 'a1', date: '2026-03-02', amountCents: 1000, personId: 'p1' });
  seedTxn(deps.db, { id: 'dep', accountId: 'a1', date: '2026-03-05', amountCents: 500 });
  const put = (key: string, body: object, id = 'dep') => send('PUT', `/v1/transactions/${id}/payback`, key, body);
  const field = async (key: string, body: object, id?: string) => { const r = await put(key, body, id); return [r.statusCode, r.json().field]; };
  assert.deepEqual(await field('v1', { personId: 'p1', items: [{ transactionId: 'theirs', amountCents: 100 }] }), [400, 'items.0.transactionId']);
  assert.deepEqual(await field('v2', { personId: 'p1', items: [{ transactionId: 'mine', amountCents: 100 }] }), [400, 'items.0.transactionId'], 'closed by the other payback');
  seedTxn(deps.db, { id: 'big', accountId: 'a1', date: '2026-03-03', amountCents: -400, personId: 'p1' });
  assert.deepEqual(await field('v3', { personId: 'p1', items: [{ transactionId: 'big', amountCents: 401 }] }), [400, 'items.0.amountCents']);
  seedTxn(deps.db, { id: 'big2', accountId: 'a1', date: '2026-03-04', amountCents: -400, personId: 'p1' });
  assert.deepEqual(await field('v4', { personId: 'p1', items: [{ transactionId: 'big', amountCents: 300 }, { transactionId: 'big2', amountCents: 300 }] }), [400, 'items']);
  assert.deepEqual(await field('v5', { personId: 'p1', items: [{ transactionId: 'big', amountCents: 100 }, { transactionId: 'big', amountCents: 100 }] }), [400, 'items.1.transactionId']);
  assert.deepEqual(await field('v6', { personId: 'p1', items: [] }, 'mine'), [400, 'personId'], 'a payback is money in');
  seedTxn(deps.db, { id: 'sp', accountId: 'a1', date: '2026-03-06', amountCents: 800 });
  seedSplit(deps.db, { id: 'S1', transactionId: 'sp', amountCents: 400, categoryId: null });
  seedSplit(deps.db, { id: 'S2', transactionId: 'sp', amountCents: 400, categoryId: null });
  assert.equal((await put('v7', { personId: 'p1', items: [] }, 'sp')).statusCode, 409);
  assert.equal((await put('v8', { personId: 'p1', lineId: 'S1', items: [{ transactionId: 'big', amountCents: 400 }] }, 'sp')).statusCode, 200, 'a positive split line can be a payback');
});

test('changing the person of a payback or an item drops its links (R6)', async () => {
  const { deps, send, link } = app();
  seedPerson(deps.db, { id: 'p2', name: 'Synthetic Wren' });
  seedTxn(deps.db, { id: 'item', accountId: 'a1', date: '2026-03-01', amountCents: -1000, personId: 'p1' });
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-02', amountCents: 1000, personId: 'p1' });
  link('k1', 'back', 'item', 1000);
  await send('PATCH', '/v1/transactions/back', 'rp-1', { personId: 'p2' });
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM iou_links').get() as { n: number }).n, 0);
  link('k2', 'back', 'item', 1000);
  await send('PATCH', '/v1/transactions/back', 'rp-2', { notes: 'x' });
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM iou_links').get() as { n: number }).n, 1, 'other edits keep links');
});

test('re-saving a split keeps links on lines whose person is unchanged; splitting a linked row moves the link to the person line (R3)', async () => {
  const { deps, send, link } = app();
  seedTxn(deps.db, { id: 'item', accountId: 'a1', date: '2026-03-01', amountCents: -2000, personId: 'p1' });
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-02', amountCents: 1000, personId: 'p1' });
  link('k1', 'back', 'item', 1000);
  const split = { lines: [{ amountCents: -1000, categoryId: null, personId: 'p1', payee: null }, { amountCents: -1000, categoryId: null, personId: null, payee: null }] };
  assert.equal((await send('PUT', '/v1/transactions/item/splits', 'sp-1', split)).statusCode, 200);
  const row = () => deps.db.prepare('SELECT item_transaction_id AS t, item_line_id AS l FROM iou_links').get() as { t: string; l: string | null } | undefined;
  const personLine = (deps.db.prepare("SELECT id FROM split_lines WHERE transaction_id = 'item' AND person_id = 'p1'").get() as { id: string }).id;
  assert.deepEqual(row(), { t: 'item', l: personLine });
  assert.equal((await send('PUT', '/v1/transactions/item/splits', 'sp-2', split)).statusCode, 200, 'unchanged re-save');
  const newLine = (deps.db.prepare("SELECT id FROM split_lines WHERE transaction_id = 'item' AND person_id = 'p1'").get() as { id: string }).id;
  assert.deepEqual(row(), { t: 'item', l: newLine });
  assert.equal((await send('PUT', '/v1/transactions/item/splits', 'sp-3', { lines: [] })).statusCode, 200, 'unsplit');
  // un-splitting leaves the row with no person (writeSplit with no lines), so the link is dropped
  assert.equal(row(), undefined);
});

test('a split that collapses on a bank amount change, or itemizes down to one person, keeps the person line\'s links on the row (R3)', async () => {
  const { deps, link } = app();
  const row = () => deps.db.prepare('SELECT item_transaction_id AS t, item_line_id AS l FROM iou_links').get();
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-05', amountCents: 2000, personId: 'p1' });
  seedTxn(deps.db, { id: 'item', accountId: 'a1', date: '2026-03-01', amountCents: -2000 });
  seedSplit(deps.db, { id: 'L1', transactionId: 'item', amountCents: -1999, categoryId: null, personId: 'p1' });
  seedSplit(deps.db, { id: 'L2', transactionId: 'item', amountCents: -1, categoryId: null });
  link('k1', 'back', 'item', 1000, 'L1');
  deps.db.prepare("UPDATE transactions SET amount_cents = -1000 WHERE id = 'item'").run();
  fitSplitToAmount(deps.db, 'item', '2026-03-02T00:00:00Z');
  assert.deepEqual(row(), { t: 'item', l: null });
  seedTxn(deps.db, { id: 'item2', accountId: 'a1', date: '2026-03-01', amountCents: -1000 });
  seedSplit(deps.db, { id: 'M1', transactionId: 'item2', amountCents: -500, categoryId: null, personId: 'p1' });
  seedSplit(deps.db, { id: 'M2', transactionId: 'item2', amountCents: -500, categoryId: null });
  deps.db.prepare('DELETE FROM iou_links').run();
  link('k2', 'back', 'item2', 500, 'M1');
  applyItems(deps.db, 'item2', { items: [{ name: 'Synthetic Ticket', amountCents: 1000, people: ['p1'] }], taxCents: 0, tipCents: 0, feesCents: 0 }, '2026-03-02T00:00:00Z');
  assert.deepEqual(row(), { t: 'item2', l: null });
});

test('changing a split line\'s person drops its links; a payee edit keeps them (R6)', async () => {
  const { deps, send, link } = app();
  const count = () => (deps.db.prepare('SELECT COUNT(*) AS n FROM iou_links').get() as { n: number }).n;
  seedTxn(deps.db, { id: 'item', accountId: 'a1', date: '2026-03-01', amountCents: -2000 });
  seedSplit(deps.db, { id: 'L1', transactionId: 'item', amountCents: -1000, categoryId: null, personId: 'p1' });
  seedSplit(deps.db, { id: 'L2', transactionId: 'item', amountCents: -1000, categoryId: null });
  seedTxn(deps.db, { id: 'back', accountId: 'a1', date: '2026-03-02', amountCents: 1000, personId: 'p1' });
  link('k1', 'back', 'item', 1000, 'L1');
  await send('PATCH', '/v1/transactions/item/lines/L1', 'pl-1', { payee: 'SYNTHETIC SHOW' });
  assert.equal(count(), 1);
  await send('PATCH', '/v1/transactions/item/lines/L1', 'pl-2', { personId: null });
  assert.equal(count(), 0);
});
