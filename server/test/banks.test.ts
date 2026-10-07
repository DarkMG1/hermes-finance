import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { decryptToken } from '../src/crypto.ts';
import { makeTestDeps, AUTH, seedItem } from './helpers.ts';

const w = (key: string) => ({ ...AUTH, 'idempotency-key': key });

test('create session returns the hosted link url', async () => {
  const { deps } = makeTestDeps();
  const res = await buildApp(deps).inject({ method: 'POST', url: '/v1/plaid/link-sessions', headers: w('l-1'), payload: { mode: 'create' } });
  assert.equal(res.statusCode, 201);
  const s = res.json();
  assert.match(s.url, /^https:\/\/hosted\.plaid\.test\//);
  assert.ok(s.sessionId);
});

test('completing a create session stores an encrypted token and syncs', async () => {
  const { deps, plaid } = makeTestDeps();
  const app = buildApp(deps);
  const s = (await app.inject({ method: 'POST', url: '/v1/plaid/link-sessions', headers: w('l-2'), payload: { mode: 'create' } })).json();
  const pending = await app.inject({ method: 'POST', url: `/v1/plaid/link-sessions/${s.sessionId}/complete`, headers: w('l-3'), payload: {} });
  assert.equal(pending.statusCode, 202);
  const linkToken = (deps.db.prepare('SELECT link_token FROM link_sessions WHERE id = ?').get(s.sessionId) as { link_token: string }).link_token;
  plaid.linkResults.set(linkToken, { status: 'complete', publicToken: 'pub-1', institutionName: 'Synthetic Bank' });
  const done = await app.inject({ method: 'POST', url: `/v1/plaid/link-sessions/${s.sessionId}/complete`, headers: w('l-4'), payload: {} });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().institutionName, 'Synthetic Bank');
  assert.equal(done.json().status, 'ok');
  const item = deps.db.prepare('SELECT * FROM items').get() as { access_token_enc: string; plaid_item_id: string };
  assert.equal(decryptToken(item.access_token_enc, deps.config.tokenKey), 'access-pub-1');
  assert.equal(item.plaid_item_id, 'plaid-item-pub-1');
  assert.deepEqual(plaid.exchanged, ['pub-1']);
  // completing again replays without a second exchange
  const again = await app.inject({ method: 'POST', url: `/v1/plaid/link-sessions/${s.sessionId}/complete`, headers: w('l-5'), payload: {} });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(plaid.exchanged, ['pub-1']);
});

test('update session fixes login without a new item or exchange', async () => {
  const { deps, plaid } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok', status: 'login_required' });
  const app = buildApp(deps);
  const s = (await app.inject({ method: 'POST', url: '/v1/plaid/link-sessions', headers: w('u-1'), payload: { mode: 'update', itemId: 'i1' } })).json();
  const linkToken = (deps.db.prepare('SELECT link_token FROM link_sessions WHERE id = ?').get(s.sessionId) as { link_token: string }).link_token;
  plaid.linkResults.set(linkToken, { status: 'complete', publicToken: null, institutionName: null });
  const done = await app.inject({ method: 'POST', url: `/v1/plaid/link-sessions/${s.sessionId}/complete`, headers: w('u-2'), payload: {} });
  assert.equal(done.json().status, 'ok');
  assert.deepEqual(plaid.exchanged, []);
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 1);
});

test('update for an unknown item is 404; exited link is 409; expired session is 410', async () => {
  const { deps, plaid } = makeTestDeps();
  const app = buildApp(deps);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/plaid/link-sessions', headers: w('x-1'), payload: { mode: 'update', itemId: 'nope' } })).statusCode, 404);
  const s = (await app.inject({ method: 'POST', url: '/v1/plaid/link-sessions', headers: w('x-2'), payload: { mode: 'create' } })).json();
  const linkToken = (deps.db.prepare('SELECT link_token FROM link_sessions WHERE id = ?').get(s.sessionId) as { link_token: string }).link_token;
  plaid.linkResults.set(linkToken, { status: 'exited' });
  assert.equal((await app.inject({ method: 'POST', url: `/v1/plaid/link-sessions/${s.sessionId}/complete`, headers: w('x-3'), payload: {} })).statusCode, 409);
  deps.db.prepare("UPDATE link_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await app.inject({ method: 'POST', url: `/v1/plaid/link-sessions/${s.sessionId}/complete`, headers: w('x-4'), payload: {} })).statusCode, 410);
});

test('banks list never exposes tokens', async () => {
  const { deps } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok-secret' });
  const body = (await buildApp(deps).inject({ method: 'GET', url: '/v1/banks', headers: AUTH })).body;
  assert.ok(!body.includes('tok-secret'));
  assert.ok(!body.includes('access_token'));
});
