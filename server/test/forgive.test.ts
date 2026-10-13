import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedTxn } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1', type: 'credit' });
  seedCategory(deps.db, { id: 'c-food', name: 'Synthetic Food' });
  seedCategory(deps.db, { id: 'c-pay', name: 'Synthetic Pay', isIncome: true });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Moss' });
  seedTxn(deps.db, { id: 'lunch', accountId: 'a1', date: '2026-03-01', amountCents: -4000, personId: 'p1', source: 'plaid', sourceId: 'l1' });
  const app = buildApp(deps);
  let n = 0;
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  const forgive = (body: object, key?: string) => send('POST', '/v1/people/p1/forgive', body, key);
  return { deps, get, send, forgive };
}

test('forgiving part lowers the balance and counts as spending in Gifts, created once', async () => {
  const { get, forgive, deps } = setup();
  const r = await forgive({ amountCents: 1500, date: '2026-03-10', notes: 'Synthetic note' });
  assert.equal(r.statusCode, 201);
  const t = r.json();
  assert.deepEqual([t.amountCents, t.forgiven, t.payee], [0, true, 'Forgave Synthetic Moss']);
  assert.deepEqual(t.splitLines.map((l: { amountCents: number; personId: string | null }) => [l.amountCents, l.personId]), [[1500, 'p1'], [-1500, null]]);
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 2500);
  const gifts = deps.db.prepare("SELECT id FROM categories WHERE name = 'Gifts'").all() as { id: string }[];
  assert.equal(gifts.length, 1);
  assert.equal(t.splitLines[1].categoryId, gifts[0]!.id);
  const spending = await get('/v1/spending?period=month&date=2026-03');
  assert.equal(spending.totalCents, 1500);
  await forgive({ amountCents: 500, date: '2026-03-11' });
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Gifts'").get() as { n: number }).n, 1);
});

test('forgiving all, a chosen category, and the refusals', async () => {
  const { get, forgive, deps } = setup();
  assert.equal((await forgive({ amountCents: 4001, date: '2026-03-10' })).statusCode, 400);
  assert.equal((await forgive({ amountCents: 100, date: '2026-03-10', categoryId: 'c-pay' })).statusCode, 400, 'income category');
  assert.equal((await forgive({ amountCents: 100, date: '2026-03-10', categoryId: 'nope' })).statusCode, 400);
  const all = await forgive({ amountCents: 4000, date: '2026-03-10', categoryId: 'c-food' });
  assert.equal(all.json().splitLines[1].categoryId, 'c-food');
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 0);
  assert.equal((await forgive({ amountCents: 1, date: '2026-03-10' })).statusCode, 409);
  deps.db.prepare("UPDATE people SET archived = 1 WHERE id = 'p1'").run();
  seedTxn(deps.db, { id: 'more', accountId: 'a1', date: '2026-03-12', amountCents: -700, personId: 'p1', source: 'plaid', sourceId: 'l2' });
  assert.equal((await forgive({ amountCents: 700, date: '2026-03-12' })).statusCode, 201, 'archived person with an open balance');
});

test('a forgiveness is locked against re-splitting and retagging, and deleting it restores the balance', async () => {
  const { get, send, forgive } = setup();
  const id = (await forgive({ amountCents: 1500, date: '2026-03-10' })).json().id as string;
  const lineId = (await get(`/v1/transactions/${id}`)).splitLines[0].id as string;
  assert.equal((await send('PUT', `/v1/transactions/${id}/splits`, { lines: [] })).statusCode, 409);
  assert.equal((await send('PATCH', `/v1/transactions/${id}/lines/${lineId}`, { personId: null })).statusCode, 409);
  const locked = await send('PATCH', `/v1/transactions/${id}`, { categoryId: 'c-food' });
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.json().code, 'FORGIVENESS_LOCKED');
  assert.equal((await send('PATCH', `/v1/transactions/${id}`, { notes: 'Synthetic' })).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/transactions/${id}`)).statusCode, 200);
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 4000);
});

test('replaying a key forgives once; suggestions ignore forgiveness rows', async () => {
  const { get, forgive } = setup();
  await forgive({ amountCents: 1000, date: '2026-03-10' }, 'same');
  await forgive({ amountCents: 1000, date: '2026-03-10' }, 'same');
  assert.equal((await get('/v1/people/p1')).person.balanceCents, 3000);
  assert.equal((await get('/v1/people/suggestions')).length, 0);
});
