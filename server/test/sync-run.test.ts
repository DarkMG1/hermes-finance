import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { startScheduler } from '../src/scheduler.ts';
import { syncAll, syncItem } from '../src/sync/run.ts';
import { txn } from './fake-plaid.ts';
import { makeTestDeps, AUTH, seedItem } from './helpers.ts';

function setup() {
  const { deps, plaid } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok-1' });
  const item = () => deps.db.prepare("SELECT * FROM items WHERE id = 'i1'").get() as Record<string, unknown>;
  const count = () => (deps.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE removed_at IS NULL').get() as { n: number }).n;
  return { deps, plaid, item, count };
}

test('multi-page sync applies everything and stores the final cursor', async () => {
  const { deps, plaid, item, count } = setup();
  plaid.queueSync([
    { added: [txn({ transactionId: 'p1' })], modified: [], removed: [], nextCursor: 'c1', hasMore: true },
    { added: [txn({ transactionId: 'p2' })], modified: [], removed: [], nextCursor: 'c2', hasMore: false },
  ]);
  const r = await syncItem(deps, 'i1');
  assert.equal(r.result, 'ok');
  assert.equal(r.added, 2);
  assert.equal(item().cursor, 'c2');
  assert.equal(count(), 2);
  assert.ok(item().last_synced_at);
});

test('mutation during pagination restarts from the stored cursor', async () => {
  const { deps, plaid, count } = setup();
  plaid.queueSync([{ added: [txn({ transactionId: 'p1' })], modified: [], removed: [], nextCursor: 'c1', hasMore: true }]);
  // first run: page 1 ok, page 2 fails with the mutation error
  const origSync = plaid.transactionsSync.bind(plaid);
  let call = 0;
  plaid.transactionsSync = async (tok, cursor) => {
    call += 1;
    if (call === 2) { plaid.runs = [[{ added: [txn({ transactionId: 'p1' }), txn({ transactionId: 'p2' })], modified: [], removed: [], nextCursor: 'c9', hasMore: false }]]; plaid.failNextSync('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'); }
    return origSync(tok, cursor);
  };
  const r = await syncItem(deps, 'i1');
  assert.equal(r.result, 'ok');
  assert.deepEqual(plaid.syncCalls, [null, 'c1', null]);
  assert.equal(count(), 2);
});

test('a crash before commit leaves no data and the old cursor', async () => {
  const { deps, plaid, item, count } = setup();
  plaid.queueSync([{ added: [txn({ transactionId: 'p1' }), txn({ transactionId: 'bad', accountId: 'pa-unknown' })], modified: [], removed: [], nextCursor: 'c1', hasMore: false }]);
  plaid.accounts = [plaid.accounts[0]!]; // pa-unknown is never upserted
  const r = await syncItem(deps, 'i1');
  assert.equal(r.result, 'error');
  assert.equal(count(), 0);
  assert.equal(item().cursor, null);
  assert.equal(item().status, 'error');
});

test('login required marks only that item, others still sync', async () => {
  const { deps, plaid, item } = setup();
  seedItem(deps, { id: 'i2', plaidItemId: 'pi2', institutionName: 'Zeta Synthetic Bank', accessToken: 'tok-2' });
  plaid.failNextSync('ITEM_LOGIN_REQUIRED');
  plaid.queueSync([{ added: [txn({ transactionId: 'p1' })], modified: [], removed: [], nextCursor: 'c1', hasMore: false }]);
  const results = await syncAll(deps);
  assert.deepEqual(results.map((r) => r.result).sort(), ['login_required', 'ok']);
  assert.equal(item().status, 'login_required');
  assert.equal(item().last_error_code, 'ITEM_LOGIN_REQUIRED');
});

test('a second concurrent sync of the same item reports already_running', async () => {
  const { deps } = setup();
  const [a, b] = await Promise.all([syncItem(deps, 'i1'), syncItem(deps, 'i1')]);
  assert.deepEqual([a.result, b.result].sort(), ['already_running', 'ok']);
});

test('the access token is decrypted for plaid and never stored in plain text', async () => {
  const { deps, plaid } = setup();
  const seen: string[] = [];
  const orig = plaid.transactionsSync.bind(plaid);
  plaid.transactionsSync = async (tok, cursor) => { seen.push(tok); return orig(tok, cursor); };
  await syncItem(deps, 'i1');
  assert.deepEqual(seen, ['tok-1']);
  const enc = (deps.db.prepare("SELECT access_token_enc FROM items WHERE id = 'i1'").get() as { access_token_enc: string }).access_token_enc;
  assert.ok(!enc.includes('tok-1'));
});

test('POST /v1/sync runs all items and GET /v1/sync/status lists banks', async () => {
  const { deps, plaid } = setup();
  plaid.queueSync([{ added: [txn({ transactionId: 'p1' })], modified: [], removed: [], nextCursor: 'c1', hasMore: false }]);
  const app = buildApp(deps);
  const res = await app.inject({ method: 'POST', url: '/v1/sync', headers: { ...AUTH, 'idempotency-key': 's-1' }, payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items[0].result, 'ok');
  const status = (await app.inject({ method: 'GET', url: '/v1/sync/status', headers: AUTH })).json();
  assert.equal(status[0].institutionName, 'Synthetic Bank');
  assert.equal(status[0].status, 'ok');
});

test('a failing sync_runs insert returns an error result and releases the item lock', async () => {
  const { deps } = setup();
  deps.db.exec('DROP TABLE sync_pages; DROP TABLE sync_runs');
  const a = await syncItem(deps, 'i1');
  const b = await syncItem(deps, 'i1');
  assert.equal(a.result, 'error');
  assert.equal(b.result, 'error');
});

test('stop() before the first tick prevents any scheduled sync', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { deps, plaid } = setup();
    const stop = startScheduler(deps);
    stop();
    mock.timers.tick(10 * 60 * 1000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(plaid.syncCalls, []);
  } finally {
    mock.timers.reset();
  }
});
