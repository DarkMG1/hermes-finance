import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyItems, computeShares, ShareError, type ShareInput, type ShareResult } from '../src/itemize.ts';
import { makeTestDeps, seedAccount, seedCategory, seedPerson, seedTxn } from './helpers.ts';
import { getTransaction } from '../src/ledger.ts';

type Vector = { name: string; input: ShareInput; expected?: ShareResult; error?: boolean };
const vectors = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'test-vectors', 'item-shares.json'), 'utf8')) as { cases: Vector[] }).cases;

for (const v of vectors) {
  test(`share vector: ${v.name}`, () => {
    if (v.error) assert.throws(() => computeShares(v.input), ShareError);
    else assert.deepEqual(computeShares(v.input), v.expected);
  });
}

test('shares always add up to the target', () => {
  const r = computeShares({ items: [{ amountCents: 333, people: ['me', 'p1', 'p2'] }, { amountCents: 777, people: ['p2', 'p3'] }], taxCents: 91, tipCents: 0, feesCents: 0, targetCents: 1201 });
  assert.equal(r.shares.reduce((s, x) => s + x.cents, 0), 1201);
});

test('receipt math rejects unsafe stored targets and item amounts without entering a remainder loop', () => {
  const input = { items: [{ amountCents: 10, people: Array.from({ length: 10 }, (_, i) => `synthetic-${i}`) }], taxCents: 0, tipCents: 0, feesCents: 0, targetCents: 100 };
  for (const amount of [1e36, Infinity, NaN, 1_000_000_001, 1.5]) {
    assert.throws(() => computeShares({ ...input, targetCents: amount }), ShareError);
    assert.throws(() => computeShares({ ...input, items: [{ amountCents: amount, people: ['me'] }] }), ShareError);
  }
  assert.equal(computeShares({ ...input, targetCents: 1_000_000_000 }).shares.reduce((sum, s) => sum + s.cents, 0), 1_000_000_000);
});

test('applyItems writes the split and stores the items and applied lines', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'card' });
  seedCategory(db, { id: 'cat-food', name: 'Synthetic Food' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Moss' });
  seedTxn(db, { id: 'own', accountId: 'card', date: '2026-03-10', amountCents: -2000, categoryId: 'cat-food', source: 'plaid', sourceId: 's-own' });
  db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES ('own', x'ffd8ff', 3, 'seed')").run();
  const t = applyItems(db, 'own', { items: [{ name: 'A', amountCents: 1000, people: ['me'] }, { name: 'B', amountCents: 1000, people: ['p1'] }], taxCents: 0, tipCents: 0, feesCents: 0 }, 'now');
  assert.deepEqual(t.splitLines.map((l) => [l.amountCents, l.personId ?? null]), [[-1000, null], [-1000, 'p1']]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM receipt_items WHERE transaction_id = 'own'").get() as { n: number }).n, 2);
  assert.ok((db.prepare("SELECT applied_lines FROM receipts WHERE transaction_id = 'own'").get() as { applied_lines: string }).applied_lines);
  assert.deepEqual(getTransaction(db, 'own', '2026-03-15')!.splitLines.length, 2);
});
