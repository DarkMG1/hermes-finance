import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeShares, ShareError, type ShareInput, type ShareResult } from '../src/itemize.ts';

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
