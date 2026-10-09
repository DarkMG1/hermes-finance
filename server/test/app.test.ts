import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { idempotentWrite } from '../src/idempotency.ts';
import { PlaidError } from '../src/plaid/port.ts';
import { makeTestDeps, AUTH } from './helpers.ts';

test('health needs no auth and reports sha and migration version', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const res = await app.inject({ method: 'GET', url: '/v1/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, gitSha: 'test-sha', dbVersion: 6 });
});

test('other routes need the bearer token', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const none = await app.inject({ method: 'GET', url: '/v1/accounts' });
  assert.equal(none.statusCode, 401);
  assert.equal(none.json().code, 'UNAUTHORIZED');
  const wrong = await app.inject({ method: 'GET', url: '/v1/accounts', headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.statusCode, 401);
});

test('unknown routes are JSON 404s', async () => {
  const { deps } = makeTestDeps();
  const res = await buildApp(deps).inject({ method: 'GET', url: '/v1/nope', headers: AUTH });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});

// Exercise the idempotency helper through a throwaway route.
function appWithCounter() {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  let calls = 0;
  for (const url of ['/v1/test-write', '/v1/test-write-2']) {
    app.post(url, async (req, reply) => {
      const r = idempotentWrite(deps, req, () => { calls += 1; return { status: 201, body: { n: calls } }; });
      return reply.code(r.status).send(r.body);
    });
  }
  return { app, calls: () => calls };
}

test('a write without Idempotency-Key is rejected', async () => {
  const { app } = appWithCounter();
  const res = await app.inject({ method: 'POST', url: '/v1/test-write', headers: AUTH, payload: { a: 1 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('same key and body replays the saved response without re-running', async () => {
  const { app, calls } = appWithCounter();
  const h = { ...AUTH, 'idempotency-key': 'k-1' };
  const a = await app.inject({ method: 'POST', url: '/v1/test-write', headers: h, payload: { a: 1 } });
  const b = await app.inject({ method: 'POST', url: '/v1/test-write', headers: h, payload: { a: 1 } });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.deepEqual(b.json(), { n: 1 });
  assert.equal(calls(), 1);
});

test('same key with a different body is 409', async () => {
  const { app } = appWithCounter();
  const h = { ...AUTH, 'idempotency-key': 'k-2' };
  await app.inject({ method: 'POST', url: '/v1/test-write', headers: h, payload: { a: 1 } });
  const res = await app.inject({ method: 'POST', url: '/v1/test-write', headers: h, payload: { a: 2 } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'IDEMPOTENCY_KEY_REUSED');
});

test('key reused on another route is 409', async () => {
  const { app } = appWithCounter();
  const h = { ...AUTH, 'idempotency-key': 'k-3' };
  await app.inject({ method: 'POST', url: '/v1/test-write', headers: h, payload: { a: 1 } });
  const res = await app.inject({ method: 'POST', url: '/v1/test-write-2', headers: h, payload: { a: 1 } });
  assert.equal(res.statusCode, 409);
});

test('a write that throws stores no key, so a retry runs again', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  let attempt = 0;
  app.post('/v1/flaky', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      attempt += 1;
      deps.db.prepare("INSERT INTO settings (key, value) VALUES ('probe', ?)").run(String(attempt));
      if (attempt === 1) throw new Error('boom');
      return { status: 200, body: { attempt } };
    });
    return reply.code(r.status).send(r.body);
  });
  const h = { ...AUTH, 'idempotency-key': 'k-4' };
  const first = await app.inject({ method: 'POST', url: '/v1/flaky', headers: h, payload: {} });
  assert.equal(first.statusCode, 500);
  assert.equal(first.json().code, 'INTERNAL');
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key='probe'").get() as { n: number }).n, 0); // rolled back
  const second = await app.inject({ method: 'POST', url: '/v1/flaky', headers: h, payload: {} });
  assert.equal(second.statusCode, 200);
});

test('a PlaidError from a route is a 502 with its code and a generic message', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  app.get('/v1/plaid-boom', async () => { throw new PlaidError('INSTITUTION_DOWN', 'secret detail'); });
  const res = await app.inject({ method: 'GET', url: '/v1/plaid-boom', headers: AUTH });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { code: 'INSTITUTION_DOWN', message: 'bank provider error' });
});
