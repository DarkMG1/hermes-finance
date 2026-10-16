import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedItem, seedTxn } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  deps.db.prepare("INSERT INTO recurring_streams VALUES ('s-tv', 'item-1', 'Synthetic TV', 'monthly', 1500, 1500, '2026-03-05', '2026-04-05', 1, 'mature', 'x', ?)").run('["tv","tv-ach"]');
  seedAccount(deps.db, { id: 'a1', type: 'credit' });
  seedTxn(deps.db, { id: 'sub', accountId: 'a1', date: '2026-03-02', amountCents: -1099, payee: 'Synthetic Music', source: 'plaid', sourceId: 'sub' });
  seedTxn(deps.db, { id: 'tv', accountId: 'a1', date: '2026-03-05', amountCents: -1500, payee: 'Synthetic TV', source: 'plaid', sourceId: 'tv' });
  // the stream's other charge carries only bank text; a same-named charge outside the stream and a non-Plaid id clash stay out
  seedTxn(deps.db, { id: 'tv-ach', accountId: 'a1', date: '2026-03-06', amountCents: -1500, bankDescription: 'SYNTHETIC ACH 0042', source: 'plaid', sourceId: 'tv-ach' });
  seedTxn(deps.db, { id: 'tv-other', accountId: 'a1', date: '2026-03-07', amountCents: -1500, payee: 'Synthetic TV', source: 'plaid', sourceId: 'tv-other' });
  seedTxn(deps.db, { id: 'tv-card', accountId: 'a1', date: '2026-03-08', amountCents: -1500, payee: 'Synthetic TV', source: 'applecard', sourceId: 'tv' });
  seedTxn(deps.db, { id: 'noname', accountId: 'a1', date: '2026-03-03', amountCents: -100, payee: '#123456', source: 'plaid', sourceId: 'nn' });
  seedTxn(deps.db, { id: 'refund', accountId: 'a1', date: '2026-03-06', amountCents: 500, payee: 'Synthetic Shop', source: 'plaid', sourceId: 'rf' });
  deps.db.prepare("INSERT INTO recurring_streams VALUES ('s-off', 'item-1', 'Synthetic Off', 'monthly', 100, 100, '2026-01-05', null, 0, 'mature', 'x', '[]')").run();
  const app = buildApp(deps);
  let n = 0;
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  return { get, send };
}

test('mark as recurring, rename, change interval, hide, show again, delete', async () => {
  const { get, send } = setup();
  const made = await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' });
  assert.equal(made.statusCode, 201);
  const id = made.json().id as string;
  assert.deepEqual([made.json().name, made.json().nextDate], ['Synthetic Music', '2026-04-02']);
  assert.equal((await send('PATCH', `/v1/recurring/${id}`, { name: 'Synthetic Tunes', frequency: 'annually' })).json().nextDate, '2027-03-02');
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { name: 'Synthetic Telly' })).json().name, 'Synthetic Telly');
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { name: null })).json().name, 'Synthetic TV');
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { hidden: true })).statusCode, 200);
  assert.equal((await get('/v1/recurring')).items.some((i: { id: string }) => i.id === 's-tv'), false);
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { hidden: false })).statusCode, 200);
  assert.equal((await send('DELETE', '/v1/recurring/s-tv')).statusCode, 409);
  assert.equal((await send('DELETE', `/v1/recurring/${id}`)).statusCode, 204);
  assert.equal((await send('PATCH', '/v1/recurring/nope', { hidden: true })).statusCode, 404);
  assert.equal((await send('PATCH', '/v1/recurring/s-off', { hidden: true })).statusCode, 404);
});

test('refusals: money in, already recurring (Plaid name), bad frequency; replay creates once', async () => {
  const { get, send } = setup();
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'refund', frequency: 'monthly' })).statusCode, 409);
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'tv', frequency: 'monthly' })).statusCode, 409);
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'unknown' })).statusCode, 400);
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'noname', frequency: 'monthly' })).json().code, 'NO_NAME');
  await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' }, 'same');
  await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' }, 'same');
  assert.equal((await get('/v1/recurring')).items.filter((i: { source: string }) => i.source === 'manual').length, 1);
});

test('already recurring also matches a renamed manual item and a renamed Plaid stream, creating nothing', async () => {
  const { get, send } = setup();
  const id = (await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly', name: 'Synthetic Tunes' })).json().id as string;
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' })).statusCode, 409);
  await send('PATCH', `/v1/recurring/${id}`, { name: 'Synthetic Other' });
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' })).statusCode, 409);
  await send('PATCH', '/v1/recurring/s-tv', { name: 'Synthetic Telly' });
  assert.equal((await send('POST', '/v1/recurring', { transactionId: 'tv', frequency: 'monthly' })).statusCode, 409);
  assert.equal((await get('/v1/recurring')).items.filter((i: { source: string }) => i.source === 'manual').length, 1);
});

test('bill history: a Plaid stream lists exactly its charges, under any name; a manual bill matches its text', async () => {
  const { get, send } = setup();
  const id = (await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly', name: 'Synthetic Tunes' })).json().id as string;
  await send('PATCH', '/v1/recurring/s-tv', { name: 'Synthetic Telly' });
  assert.equal((await get('/v1/recurring')).items.some((i: object) => 'matchName' in i), false);
  const tv = await get('/v1/payee-history?recurringId=s-tv');
  assert.equal(tv.name, 'Synthetic Telly');
  assert.deepEqual(tv.rows.map((r: { transactionId: string; name: string }) => [r.transactionId, r.name]), [['tv-ach', 'SYNTHETIC ACH 0042'], ['tv', 'Synthetic TV']]);
  const tunes = await get(`/v1/payee-history?recurringId=${id}`);
  assert.deepEqual([tunes.name, tunes.rows.map((r: { transactionId: string }) => r.transactionId)], ['Synthetic Tunes', ['sub']]);
  assert.equal((await get('/v1/payee-history?recurringId=nope')).code, 'NOT_FOUND');
  assert.equal((await get('/v1/payee-history?recurringId=s-tv&name=Synthetic%20TV')).code, 'INVALID_REQUEST');
  assert.equal((await get('/v1/payee-history')).code, 'INVALID_REQUEST');
});
