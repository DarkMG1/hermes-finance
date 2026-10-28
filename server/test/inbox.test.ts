import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInboxRow, linkInbox, listInbox, markInterruptedReads, matchInbox, saveInboxItems, storeRead } from '../src/inbox.ts';
import { getTransaction } from '../src/ledger.ts';
import { applyItems, getItemization } from '../src/itemize.ts';
import { getPerson } from '../src/people.ts';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

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

test('inbox lists distinct tagged people without Me and never reports untagged item defaults as a split', () => {
  const { db, snap } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  const listed = () => listInbox(db, '2026-03-15').waiting[0]!;
  assert.deepEqual(listed().taggedPersonIds, []);
  for (const people of [['me', 'p1'], ['p2', 'p1'], ['p1'], ['me']]) {
    saveInboxItems(db, 'r1', { ...READ, items: READ.items.map((i) => ({ ...i, people })) });
    assert.deepEqual(listed().taggedPersonIds, people.filter((p) => p !== 'me').sort());
  }
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'p2' WHERE id = 'r1'").run();
  assert.equal(listed().forPersonId, 'p2');
  storeRead(db, 'r1', READ, 'again');
  assert.deepEqual(listed().taggedPersonIds, []);
});

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
  assert.equal(getTransaction(db, 'c1', '2026-03-15')!.hasReceipt, true);
  assert.deepEqual((db.prepare("SELECT people FROM receipt_items WHERE transaction_id = 'c1' ORDER BY position").all() as { people: string }[]).map((r) => r.people), ['["me"]', '["me"]']);
  assert.deepEqual(listInbox(db, '2026-03-15').recentlyLinked.map((l) => [l.id, l.transactionId, l.splitApplied]), [['r1', 'c1', false]]);
  assert.equal(listInbox(db, '2026-03-15').waiting.length, 0);
});

for (const auto of [false, true]) for (const tagged of [false, true]) test(`For-person ${auto ? 'auto' : 'manual'} link tags the whole charge (items tagged: ${tagged})`, () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  if (tagged) saveInboxItems(db, 'r1', { ...READ, items: READ.items.map((i) => ({ ...i, people: ['me', 'p2'] })) });
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'p1' WHERE id = 'r1'").run();
  const before = getInboxRow(db, 'r1')!;
  charge('c1', '2026-03-11', -1050);
  if (auto) assert.equal(matchInbox(deps), 1);
  else assert.equal(linkInbox(deps, 'r1', 'c1').splitApplied, false);
  const transaction = getTransaction(db, 'c1', '2026-03-15')!;
  assert.equal(transaction.personId, 'p1');
  assert.equal(transaction.categoryId, null);
  assert.deepEqual(transaction.splitLines, []);
  assert.equal(db.prepare("SELECT category_owner_set FROM transactions WHERE id = 'c1'").pluck().get(), 1);
  assert.equal(getPerson(db, 'p1')!.person.balanceCents, 1050);
  assert.equal(getPerson(db, 'p2')!.person.balanceCents, 0);
  assert.equal(getInboxRow(db, 'r1')!.split_applied, 0);
  const receipt = getItemization(db, 'c1');
  assert.deepEqual(receipt.items.map(({ name, amountCents, people }) => ({ name, amountCents, people })), JSON.parse(before.items!));
  assert.deepEqual([receipt.totalCents, receipt.taxCents, receipt.tipCents, receipt.feesCents], [1050, 50, 0, 0]);
});

for (const removed of [false, true]) test(`For-person survives ${removed ? 'Plaid removal' : 'manual deletion'} and relinking`, async () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'p1' WHERE id = 'r1'").run();
  charge('old', '2026-03-11', -1050, removed ? {} : { source: 'manual', sourceId: undefined });
  linkInbox(deps, 'r1', 'old');
  if (removed) {
    db.prepare("UPDATE transactions SET removed_at = 'gone' WHERE id = 'old'").run();
    matchInbox(deps);
  } else {
    const app = buildApp(deps);
    const response = await app.inject({ method: 'DELETE', url: '/v1/transactions/old', headers: { ...AUTH, 'idempotency-key': 'delete' } });
    assert.equal(response.statusCode, 200);
    await app.close();
  }
  assert.equal(listInbox(db, '2026-03-15').waiting[0]!.forPersonId, 'p1');
  assert.equal(getInboxRow(db, 'r1')!.linked_at, null);
  charge('new', '2026-03-12', -1050);
  assert.equal(matchInbox(deps), 1);
  assert.equal(getTransaction(db, 'new', '2026-03-15')!.personId, 'p1');
  assert.equal(getPerson(db, 'p1')!.person.balanceCents, 1050);
});

test('For-person refuses Paid-by and split targets without changing them', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'p1' WHERE id = 'r1'").run();
  charge('paid', '2026-03-11', -1050, { source: 'manual', sourceId: undefined, paidByPersonId: 'p2' });
  charge('split', '2026-03-11', -1050);
  seedSplit(db, { id: 'l1', transactionId: 'split', amountCents: -500, categoryId: 'cat-food' });
  seedSplit(db, { id: 'l2', transactionId: 'split', amountCents: -550, categoryId: null, personId: 'p2' });
  for (const [id, code] of [['paid', 'PAID_BY_PERSON'], ['split', 'SPLIT_TRANSACTION']] as const) {
    const before = getTransaction(db, id, '2026-03-15');
    assert.throws(() => linkInbox(deps, 'r1', id), (e: { code: string }) => e.code === code);
    assert.deepEqual(getTransaction(db, id, '2026-03-15'), before);
  }
  assert.deepEqual(listInbox(db, '2026-03-15').waiting[0]!.suggestions, []);
  assert.equal(matchInbox(deps), 0);
  assert.equal(getInboxRow(db, 'r1')!.linked_at, null);
});

test('a person archived after selecting For cannot acquire a new charge on link', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'p1' WHERE id = 'r1'").run();
  db.prepare("UPDATE people SET archived = 1 WHERE id = 'p1'").run();
  charge('c1', '2026-03-11', -1050);
  const before = getTransaction(db, 'c1', '2026-03-15');
  assert.throws(() => linkInbox(deps, 'r1', 'c1'), /person is archived/);
  assert.deepEqual(getTransaction(db, 'c1', '2026-03-15'), before);
  assert.equal(getInboxRow(db, 'r1')!.linked_at, null);
});

test('two exact charges, or two receipts after one charge, only suggest', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  charge('c1', '2026-03-11', -1050);
  charge('c2', '2026-03-12', -1050);
  assert.equal(matchInbox(deps), 0);
  assert.deepEqual(listInbox(db, '2026-03-15').waiting[0]!.suggestions.map((s) => s.id), ['c2', 'c1']);
  const two = setup();
  two.snap('a'); two.snap('b');
  storeRead(two.db, 'a', READ, 'now'); storeRead(two.db, 'b', READ, 'now');
  two.charge('c1', '2026-03-11', -1050);
  assert.equal(matchInbox(two.deps), 0);
  assert.deepEqual(listInbox(two.db, '2026-03-15').waiting.map((w) => w.suggestions.map((s) => s.id)), [['c1'], ['c1']]);
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
  assert.deepEqual(listInbox(db, '2026-03-15').waiting[0]!.suggestions.map((s) => s.id), ['tip']);
});

test('tagged items are applied as the split on link; a hand-split charge keeps its split', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  saveInboxItems(db, 'r1', { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }, { name: 'Synthetic Jam', amountCents: 600, people: ['me', 'p1'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
  charge('c1', '2026-03-11', -1100);
  const linked = linkInbox(deps, 'r1', 'c1');
  assert.equal(linked.splitApplied, true);
  const lines = getTransaction(db, 'c1', '2026-03-15')!.splitLines;
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
  assert.deepEqual(getTransaction(b.db, 'c1', '2026-03-15')!.splitLines.map((l) => l.amountCents), [-1000, -50]);
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
  assert.equal(getTransaction(b.db, 'paid', '2026-03-15')!.amountCents, -525);
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

test('an exact-amount charge from another store only suggests; a receipt with no store never links', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  charge('other', '2026-03-11', -1050, { bankDescription: 'HARDWARE DEPOT 02' });
  assert.equal(matchInbox(deps), 0);
  assert.deepEqual(listInbox(db, '2026-03-15').waiting[0]!.suggestions.map((s) => s.id), ['other']);
  snap('r2');
  storeRead(db, 'r2', { ...READ, merchant: null, totalCents: 777 }, 'now');
  charge('c2', '2026-03-11', -777);
  assert.equal(matchInbox(deps), 0);
});

test('tags of me + the payer are applied on a they-paid target', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  saveInboxItems(db, 'r1', { items: [{ name: 'Synthetic Bread', amountCents: 400, people: ['me'] }, { name: 'Synthetic Jam', amountCents: 600, people: ['me', 'p1'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
  charge('paid', '2026-03-11', -1050, { source: 'manual', sourceId: undefined, paidByPersonId: 'p1' });
  assert.equal(linkInbox(deps, 'r1', 'paid').splitApplied, true);
});

test('a linked pending charge removed with no posted row gives the receipt back, and it links to the next match', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  charge('pend', '2026-03-11', -1050, { pending: true });
  assert.equal(matchInbox(deps), 1);
  db.prepare("UPDATE transactions SET removed_at = 'gone' WHERE id = 'pend'").run();
  assert.equal(matchInbox(deps), 0);
  const row = getInboxRow(db, 'r1')!;
  assert.deepEqual([row.linked_transaction_id, row.linked_at, row.split_applied], [null, null, 0]);
  assert.deepEqual(row.jpeg, JPEG);
  assert.equal(db.prepare("SELECT 1 FROM receipts WHERE transaction_id = 'pend'").get(), undefined);
  charge('c2', '2026-03-12', -1050);
  assert.equal(matchInbox(deps), 1);
  assert.equal(getInboxRow(db, 'r1')!.linked_transaction_id, 'c2');
});

test('a restart mid-read marks the read failed; tagged, read or linked rows are left alone', () => {
  const { db, snap } = setup();
  snap('mid');
  snap('tagged');
  saveInboxItems(db, 'tagged', { items: [{ name: 'Synthetic Pear', amountCents: 300, people: ['me'] }], taxCents: 0, tipCents: 0, feesCents: 0 });
  snap('done');
  storeRead(db, 'done', READ, 'now');
  markInterruptedReads(db);
  assert.deepEqual(['mid', 'tagged', 'done'].map((id) => getInboxRow(db, id)!.read_failed), [1, 0, 0]);
});

test('stop-words are not merchant evidence: The Corner Store vs THE HOME DEPOT only suggests', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', { ...READ, merchant: 'The Corner Store' }, 'now');
  charge('c1', '2026-03-11', -1050, { bankDescription: 'THE HOME DEPOT' });
  assert.equal(matchInbox(deps), 0);
  assert.equal(getInboxRow(db, 'r1')!.linked_transaction_id, null);
});

test('a waiting receipt offers the payee name already used for its store: most specific, then most used', () => {
  const { db, snap } = setup();
  seedCategory(db, { id: 'cat-xfer', name: 'Synthetic Transfer', isTransfer: true });
  const read = (id: string, merchant: string | null) => { snap(id); storeRead(db, id, { ...READ, merchant }, 'now'); };
  read('r1', 'Synthetic Grocer Wholesale #42');
  read('r2', 'Synthetic Bakery');
  read('r3', 'SYNTHETIC GROCERIES');
  read('r4', 'Synthetic Moss Club');
  read('r5', 'Synthetic Tires');
  read('r6', null);
  read('r7', 'Synthetic Mart Express');
  const txn = (id: string, more: Partial<Parameters<typeof seedTxn>[1]>) => seedTxn(db, { id, accountId: 'card', date: '2026-01-01', amountCents: -1, ...more });
  txn('k1', { payee: 'Synthetic Grocer' });
  txn('k2', { payee: 'SYNTHETIC GROCER' });
  txn('k3', { payee: 'Synthetic Grocer' });
  txn('k4', { payee: 'Synthetic' });
  txn('k5', { payee: 'Synthetic Grocer Annex' });
  // removed, a person's row, a transfer and money in never name a store
  txn('k6', { payee: 'SYNTHETIC GROCER', removedAt: 'x' });
  txn('k7', { payee: 'SYNTHETIC GROCER', removedAt: 'x' });
  txn('k8', { payee: 'Synthetic Moss', personId: 'p1' });
  txn('k9', { payee: 'Synthetic Moss', categoryId: 'cat-xfer' });
  txn('k10', { payee: 'Synthetic Moss', amountCents: 100 });
  // a bank row's merchant name is its shown name until renamed
  txn('k11', { merchantName: 'Synthetic Mart', source: 'plaid', sourceId: 's-k11' });
  const payees = Object.fromEntries(listInbox(db, '2026-03-15').waiting.map((w) => [w.id, w.payee]));
  assert.deepEqual(payees, { r1: 'Synthetic Grocer', r2: 'Synthetic', r3: 'Synthetic', r4: 'Synthetic', r5: 'Synthetic', r6: null, r7: 'Synthetic Mart' });
});

test('a receipt with no known store keeps its own name', () => {
  const { db, snap } = setup();
  snap('r1');
  storeRead(db, 'r1', { ...READ, merchant: 'Synthetic Bakery' }, 'now');
  assert.equal(listInbox(db, '2026-03-15').waiting[0]!.payee, 'Synthetic Bakery');
});

test('restoration preserves current itemization and relinks without resurrecting obsolete tags', async () => {
  for (const readAgain of [false, true]) {
    const { deps, db, snap, charge, reader } = setup();
    snap('r1');
    storeRead(db, 'r1', READ, 'first-read');
    saveInboxItems(db, 'r1', { items: [{ name: 'Synthetic Bread', amountCents: 1000, people: ['me', 'p1'] }], taxCents: 50, tipCents: 0, feesCents: 0 });
    charge('old', '2026-03-11', -1050, { pending: true });
    linkInbox(deps, 'r1', 'old');
    if (readAgain) {
      reader.next = { ...READ, items: [{ name: 'Synthetic Pear', amountCents: 1000 }], taxCents: 10, tipCents: 20, feesCents: 30, model: 'new-model' };
      const r = await buildApp(deps).inject({ method: 'POST', url: '/v1/transactions/old/receipt/read', headers: AUTH });
      assert.equal(r.statusCode, 200);
    } else {
      applyItems(db, 'old', { items: [{ name: 'Synthetic Pear', amountCents: 900, people: ['me'] }], taxCents: 10, tipCents: 100, feesCents: 40 }, deps.now().toISOString());
    }
    db.prepare("UPDATE inbox_receipts SET read_failed = 1 WHERE id = 'r1'").run();
    const current = getItemization(db, 'old');
    db.prepare("UPDATE transactions SET removed_at = 'gone' WHERE id = 'old'").run();
    assert.equal(matchInbox(deps), 0);
    const restored = getInboxRow(db, 'r1')!;
    assert.deepEqual(JSON.parse(restored.items!), current.items.map(({ name, amountCents, people }) => ({ name, amountCents, people })));
    assert.deepEqual([restored.tax_cents, restored.tip_cents, restored.fees_cents, restored.total_cents, restored.read_at],
      [current.taxCents, current.tipCents, current.feesCents, current.totalCents, current.readAt]);
    assert.equal(restored.tagged, readAgain ? 0 : 1);
    assert.equal(restored.read_failed, 0);
    assert.deepEqual(restored.jpeg, JPEG);
    charge('new', '2026-03-12', -1050);
    assert.equal(matchInbox(deps), 1);
    const linked = getTransaction(db, 'new', '2026-03-15')!;
    assert.equal(linked.personId, null);
    assert.deepEqual(linked.splitLines, []);
    assert.equal(getItemization(db, 'new').items[0]!.name, 'Synthetic Pear');
  }
});

test('inbox listing and matching read metadata without materializing receipt photos', (t) => {
  const { deps, db, snap } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  const prepare = db.prepare.bind(db);
  let checked = 0;
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (/SELECT .* FROM inbox_receipts WHERE linked_at/s.test(sql)) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args: unknown[]) => {
        const rows = all(...args) as object[];
        for (const row of rows) assert.equal('jpeg' in row, false);
        checked += 1;
        return rows;
      });
    }
    return statement;
  });
  assert.equal(listInbox(db, '2026-03-15').waiting.length, 1);
  assert.equal(matchInbox(deps), 0);
  assert.equal(checked, 3);
});

test('restoration leaves unapplied inbox tags untagged when the first link kept an existing bank split', () => {
  const { deps, db, snap, charge } = setup();
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  const body = { items: [{ name: 'Synthetic Pear', amountCents: 1000, people: ['me', 'p2'] }], taxCents: 50, tipCents: 0, feesCents: 0 };
  saveInboxItems(db, 'r1', body);
  charge('old', '2026-03-11', -1050);
  seedSplit(db, { id: 'l1', transactionId: 'old', amountCents: -500, categoryId: 'cat-food' });
  seedSplit(db, { id: 'l2', transactionId: 'old', amountCents: -550, categoryId: null, personId: 'p1' });
  assert.equal(linkInbox(deps, 'r1', 'old').splitApplied, false);
  db.prepare("UPDATE transactions SET removed_at = 'gone' WHERE id = 'old'").run();
  matchInbox(deps);
  assert.equal(getInboxRow(db, 'r1')!.tagged, 0);
  assert.deepEqual(JSON.parse(getInboxRow(db, 'r1')!.items!), body.items);
  charge('new', '2026-03-12', -1050);
  assert.equal(matchInbox(deps), 1);
  assert.deepEqual(getTransaction(db, 'new', '2026-03-15')!.splitLines, []);
});

for (const edit of ['shares', 'remove', 'forgive']) test(`restoration never resurrects obsolete debt after ${edit}`, async () => {
  const { deps, db, snap, charge } = setup();
  const app = buildApp(deps);
  snap('r1');
  storeRead(db, 'r1', READ, 'now');
  saveInboxItems(db, 'r1', { items: [{ name: 'Synthetic Pear', amountCents: 1050, people: ['me', 'p1'] }], taxCents: 0, tipCents: 0, feesCents: 0 });
  charge('old', '2026-03-11', -1050);
  linkInbox(deps, 'r1', 'old');
  const headers = { ...AUTH, 'idempotency-key': 'edit' };
  if (edit === 'forgive') {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/people/p1/forgive', headers,
      payload: { amountCents: 525, date: '2026-03-12' } })).statusCode, 201);
  } else {
    const lines = edit === 'remove' ? [] : [
      { amountCents: -850, categoryId: 'cat-food', personId: null, payee: null },
      { amountCents: -200, categoryId: null, personId: 'p1', payee: null },
    ];
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/transactions/old/splits', headers, payload: { lines } })).statusCode, 200);
  }
  db.prepare("UPDATE transactions SET removed_at = 'gone' WHERE id = 'old'").run();
  matchInbox(deps);
  assert.equal(getInboxRow(db, 'r1')!.tagged, edit === 'forgive' ? 1 : 0);
  charge('new', '2026-03-12', -1050);
  assert.equal(matchInbox(deps), 1);
  assert.equal(getPerson(db, 'p1')!.person.balanceCents, 0);
  if (edit !== 'forgive') assert.deepEqual(getTransaction(db, 'new', '2026-03-15')!.splitLines, []);
});
