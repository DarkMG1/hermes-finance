import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { idempotentAsync, idempotentWrite } from '../src/idempotency.ts';
import { makeTestDeps } from './helpers.ts';

const request = (body: object = {}) => ({ method: 'POST', url: '/synthetic', headers: { 'idempotency-key': 'same' }, body }) as unknown as FastifyRequest;

test('overlapping async writes share one result and reject different requests before side effects', async () => {
  const { deps } = makeTestDeps();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const run = async () => { calls += 1; await gate.promise; return { status: 201, body: { id: calls } }; };
  const a = idempotentAsync(deps, request(), run);
  const b = idempotentAsync(deps, request(), run);
  const mismatch = assert.rejects(idempotentAsync(deps, request({ changed: true }), run), { code: 'IDEMPOTENCY_KEY_REUSED' });
  await Promise.resolve();
  gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  await mismatch;
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(await idempotentAsync(deps, request(), run), first);
  assert.equal(calls, 1);
});

test('a reserved key cannot be reused by a synchronous write', async () => {
  const { deps } = makeTestDeps();
  const gate = Promise.withResolvers<void>();
  const pending = idempotentAsync(deps, request(), async () => { await gate.promise; return { status: 201, body: {} }; });
  try {
    assert.throws(() => idempotentWrite(deps, request({ changed: true }), () => ({ status: 200, body: {} })), { code: 'IDEMPOTENCY_KEY_REUSED' });
  } finally { gate.resolve(); await pending; }
});

test('errors and nonfinal replies release reservations, and separate databases do not share them', async () => {
  const { deps } = makeTestDeps();
  await assert.rejects(idempotentAsync(deps, request(), () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  for (const result of [{ status: 202, body: {} }, { status: 200, body: {}, final: false }]) {
    assert.deepEqual(await idempotentAsync(deps, request(), async () => result), result);
    assert.equal(deps.db.prepare('SELECT 1 FROM idempotency_keys').get(), undefined);
  }
  const gate = Promise.withResolvers<void>();
  const pending = idempotentAsync(deps, request(), async () => { await gate.promise; return { status: 201, body: 'first' }; });
  try {
    const other = makeTestDeps().deps;
    assert.deepEqual(await idempotentAsync(other, request(), async () => ({ status: 201, body: 'second' })), { status: 201, body: 'second' });
  } finally { gate.resolve(); await pending; }
});
