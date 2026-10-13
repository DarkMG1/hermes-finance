import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInboxRow, linkInbox, listInbox, matchInbox, saveInboxItems, storeRead } from '../src/inbox.ts';
import { getTransaction } from '../src/ledger.ts';
import { makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const READ = { items: [{ name: 'Synthetic Bread', amountCents: 400 }, { name: 'Synthetic Jam', amountCents: 600 }], taxCents: 50, tipCents: 0, feesCents: 0,
  totalCents: 1050, merchant: 'Synthetic Grocer', purchaseDate: '2026-03-10', model: 'fake-model' };

function setup() {
  const t = makeTestDeps();
  const { db } = t.deps;
  seedAccount(db, { id: 'card', type: 'credit' });
  seedCategory(db, { id: 'cat-food', name: 'Synthetic Food' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Moss' });
  seedPerson(db, { id: 'p2', name: 'Synthetic Fern' });
  const snap = (id: string) => db.prepare("INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES (?, ?, ?, '2026-03-10T18:00:00.000Z')").run(id, JPEG, JPEG.length);
  const charge = (id: string, date: string, amountCents: number, extra: Partial<Parameters<typeof seedTxn>[1]> = {}) =>
    seedTxn(db, { id, accountId: 'card', date, amountCents, source: 'plaid', sourceId: `s-${id}`, bankDescription: 'SYNTHETIC GROCER 01', categoryId: 'cat-food', ...extra });
  return { ...t, db, snap, charge };
}

test('one exact charge in the window links on its own; the photo moves and the items default to me', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  assert.equal(storeRead(db, 'r1', READ, 'now'), true);
  charge('c1', '2026-03-11', -1050);
  charge('far', '2026-03-20', -1050);
  assert.equal(matchInbox(deps), 1);
  const row = getInboxRow(db, 'r1')!;
  assert.equal(row.linked_transaction_id, 'c1');
  assert.equal(row.jpeg, null);
  assert.equal(getTransaction(db, 'c1')!.hasReceipt, true);
  assert.deepEqual((db.prepare("SELECT people FROM receipt_items WHERE transaction_id = 'c1' ORDER BY position").all() as { people: string }[]).map((r) => r.people), ['["me"]', '["me"]']);
  assert.deepEqual(listInbox(db).recentlyLinked.map((l) => [l.id, l.transactionId, l.splitApplied]), [['r1', 'c1', false]]);
  assert.equal(listInbox(db).waiting.length, 0);
});

test('two exact charges, or two receipts after one charge, only suggest', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  charge('c1', '2026-03-11', -1050);
  charge('c2', '2026-03-12', -1050);
  assert.equal(matchInbox(deps), 0);
  assert.deepEqual(listInbox(db).waiting[0]!.suggestions.map((s) => s.id), ['c2', 'c1']);
  const two = setup();
  two.snap('a'); two.snap('b');
  storeRead(two.db, 'a', READ, 'now'); storeRead(two.db, 'b', READ, 'now');
  two.charge('c1', '2026-03-11', -1050);
  assert.equal(matchInbox(two.deps), 0);
  assert.deepEqual(listInbox(two.db).waiting.map((w) => w.suggestions.map((s) => s.id)), [['c1'], ['c1']]);
});

test('a tip-sized charge from the same store is a suggestion; another store, a they-paid row or one with a receipt is not', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  charge('tip', '2026-03-11', -1260);
  charge('other', '2026-03-11', -1100, { bankDescription: 'HARDWARE DEPOT 02' });
  charge('toomuch', '2026-03-11', -1400);
  charge('theirs', '2026-03-11', -1050, { source: 'manual', sourceId: undefined, paidByPersonId: 'p1' });
  charge('hasone', '2026-03-11', -1050);
  db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('hasone', x'ffd8ff', 3, 'seed')").run();
  assert.equal(matchInbox(deps), 0);
  assert.deepEqual(listInbox(db).waiting[0]!.suggestions.map((s) => s.id), ['tip']);
});

test('tagged items are applied as the split on link; a hand-split charge keeps its split', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  saveInboxItems(db, 'r1', { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }, { name: 'Synthetic Jam', amountCents: 600, people: ['me', 'p1'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
  charge('c1', '2026-03-11', -1100);
  const linked = linkInbox(deps, 'r1', 'c1');
  assert.equal(linked.splitApplied, true);
  const lines = getTransaction(db, 'c1')!.splitLines;
  assert.equal(lines.reduce((s, l) => s + l.amountCents, 0), -1100);
  assert.deepEqual(lines.map((l) => l.personId ?? null), [null, 'p1']);

  const b = setup();
  b.snap('r1');
  storeRead(b.db, 'r1', READ, 'now');
  saveInboxItems(b.db, 'r1', { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }, { name: 'Synthetic Jam', amountCents: 600, people: ['p1'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
  b.charge('c1', '2026-03-11', -1050);
  seedSplit(b.db, { id: '00-a', transactionId: 'c1', amountCents: -1000, categoryId: 'cat-food' });
  seedSplit(b.db, { id: '01-b', transactionId: 'c1', amountCents: -50, categoryId: null, personId: 'p2' });
  const kept = linkInbox(b.deps, 'r1', 'c1');
  assert.equal(kept.splitApplied, false);
  assert.deepEqual(getTransaction(b.db, 'c1')!.splitLines.map((l) => l.amountCents), [-1000, -50]);
  assert.deepEqual((b.db.prepare("SELECT people FROM receipt_items WHERE transaction_id = 'c1' ORDER BY position").all() as { people: string }[]).map((r) => r.people), ['["me"]', '["p1"]']);
});

test('a they-paid target defaults items to me + payer, and a third person leaves the tags unapplied', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  charge('paid', '2026-03-11', -525, { source: 'manual', sourceId: undefined, paidByPersonId: 'p1' });
  linkInbox(deps, 'r1', 'paid');
  assert.deepEqual((db.prepare("SELECT people FROM receipt_items WHERE transaction_id = 'paid' ORDER BY position").all() as { people: string }[]).map((r) => r.people), ['["me","p1"]', '["me","p1"]']);

  const b = setup();
  b.snap('r1');
  storeRead(b.db, 'r1', READ, 'now');
  saveInboxItems(b.db, 'r1', { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }, { name: 'Synthetic Jam', amountCents: 600, people: ['p2'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
  b.charge('paid', '2026-03-11', -525, { source: 'manual', sourceId: undefined, paidByPersonId: 'p1' });
  assert.equal(linkInbox(b.deps, 'r1', 'paid').splitApplied, false);
  assert.equal(getTransaction(b.db, 'paid')!.amountCents, -525);
});

test('link refusals: unknown, money in, already has a receipt, already linked', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  charge('refund', '2026-03-11', 500);
  charge('hasone', '2026-03-11', -500);
  db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('hasone', x'ffd8ff', 3, 'seed')").run();
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code: string }).code; } };
  assert.equal(code(() => linkInbox(deps, 'r1', 'missing')), 'NOT_FOUND');
  assert.equal(code(() => linkInbox(deps, 'nope', 'hasone')), 'NOT_FOUND');
  assert.equal(code(() => linkInbox(deps, 'r1', 'refund')), 'NOT_MONEY_OUT');
  assert.equal(code(() => linkInbox(deps, 'r1', 'hasone')), 'HAS_RECEIPT');
  charge('c1', '2026-03-11', -500);
  linkInbox(deps, 'r1', 'c1');
  assert.equal(code(() => linkInbox(deps, 'r1', 'c1')), 'NOT_FOUND');
});

test('storeRead does nothing on a linked or deleted row; saving tags sets a missing total', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  charge('c1', '2026-03-11', -500);
  linkInbox(deps, 'r1', 'c1');
  assert.equal(storeRead(db, 'r1', READ, 'now'), false);
  assert.equal(storeRead(db, 'gone', READ, 'now'), false);
  snap('r2');
  saveInboxItems(db, 'r2', { items: [{ name: 'Synthetic Pear', amountCents: 300, people: ['me'] }], taxCents: 20, tipCents: 0, feesCents: 0 });
  assert.equal(getInboxRow(db, 'r2')!.total_cents, 320);
});
