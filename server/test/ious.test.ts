import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, entryKey, type Tagged, type Link } from '../src/ious.ts';

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
