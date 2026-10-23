import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { getTransaction } from '../src/ledger.ts';
import { AUTH, makeTestDeps, seedAccount, seedTxn } from './helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk' });
  seedTxn(deps.db, { id: 't1', accountId: 'chk', date: '2026-03-01', amountCents: -500 });
  seedTxn(deps.db, { id: 'gone', accountId: 'chk', date: '2026-03-01', amountCents: -500, removedAt: 'x' });
  const app = buildApp(deps);
  const put = (id: string, payload: Buffer | string, type = 'image/jpeg') =>
    app.inject({ method: 'PUT', url: `/v1/transactions/${id}/receipt`, headers: { ...AUTH, 'content-type': type }, payload });
  const get = (id: string) => app.inject({ method: 'GET', url: `/v1/transactions/${id}/receipt`, headers: AUTH });
  const del = (id: string) => app.inject({ method: 'DELETE', url: `/v1/transactions/${id}/receipt`, headers: AUTH });
  return { deps, put, get, del };
}

test('put, get, replace and delete a receipt', async () => {
  const { deps, put, get, del } = setup();
  assert.equal((await get('t1')).statusCode, 404);
  const res = await put('t1', JPEG);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { bytes: JPEG.length });
  const got = await get('t1');
  assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.deepEqual(got.rawPayload, JPEG);
  assert.equal(getTransaction(deps.db, 't1', '2026-03-15')?.hasReceipt, true);
  const other = Buffer.from([0xff, 0xd8, 0xff, 9]);
  await put('t1', other);
  assert.deepEqual((await get('t1')).rawPayload, other);
  assert.equal((await del('t1')).statusCode, 204);
  assert.equal((await del('t1')).statusCode, 204, 'delete is idempotent');
  assert.equal(getTransaction(deps.db, 't1', '2026-03-15')?.hasReceipt, false);
});

test('rejects non-JPEG bodies, other content types, oversize bodies and unknown rows', async () => {
  const { deps, put } = setup();
  assert.equal((await put('t1', Buffer.from('not a jpeg'))).statusCode, 400);
  assert.equal((await put('t1', Buffer.alloc(0))).statusCode, 400);
  assert.equal((await put('t1', JSON.stringify({ a: 1 }), 'application/json')).statusCode, 415);
  assert.equal((await put('t1', Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024 - JPEG.length + 1)]))).statusCode, 413);
  assert.equal((await put('missing', JPEG)).statusCode, 404);
  assert.equal((await put('gone', JPEG)).statusCode, 404);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n, 0);
});

test('deleting a manual transaction deletes its receipt', async () => {
  const { deps, put } = setup();
  await put('t1', JPEG);
  deps.db.prepare("DELETE FROM transactions WHERE id = 't1'").run();
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n, 0);
});

test('other routes keep the 64 KB limit for image/jpeg bodies', async () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk' });
  seedTxn(deps.db, { id: 't1', accountId: 'chk', date: '2026-03-01', amountCents: -500 });
  const app = buildApp(deps);
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t1', headers: { ...AUTH, 'content-type': 'image/jpeg', 'idempotency-key': 'k1' },
    payload: Buffer.alloc(100 * 1024) });
  assert.equal(res.statusCode, 413);
});

test('responses carry nosniff', async () => {
  const { get } = setup();
  assert.equal((await get('t1')).headers['x-content-type-options'], 'nosniff');
});
