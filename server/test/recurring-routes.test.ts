import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedItem, seedPerson, seedSplit, seedTxn } from './helpers.ts';

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
  seedTxn(deps.db, { id: 'tv-card', accountId: 'a1', date: '2026-03-08', amountCents: -1500, payee: 'Synthetic Card', source: 'applecard', sourceId: 'tv' });
  seedTxn(deps.db, { id: 'noname', accountId: 'a1', date: '2026-03-03', amountCents: -100, payee: '#123456', source: 'plaid', sourceId: 'nn' });
  seedTxn(deps.db, { id: 'refund', accountId: 'a1', date: '2026-03-06', amountCents: 500, payee: 'Synthetic Shop', source: 'plaid', sourceId: 'rf' });
  deps.db.prepare("INSERT INTO recurring_streams VALUES ('s-off', 'item-1', 'Synthetic Off', 'monthly', 100, 100, '2026-01-05', null, 0, 'mature', 'x', '[]')").run();
  const app = buildApp(deps);
  let n = 0;
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  return { get, send, db: deps.db };
}

test('mark as recurring, rename, change interval, hide, show again, delete', async () => {
  const { get, send, db } = setup();
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
  // a stream Plaid stopped is still there, ended; a tombstoned one is gone
  assert.deepEqual([(await send('PATCH', '/v1/recurring/s-off', { hidden: true })).json().ended], [true]);
  db.prepare("UPDATE recurring_streams SET status = 'tombstoned' WHERE stream_id = 's-off'").run();
  assert.equal((await send('PATCH', '/v1/recurring/s-off', { hidden: false })).statusCode, 404);
});

test('renaming an irregular bill preserves its interval, prediction and monthly total', async () => {
  const { get, send, db } = setup();
  db.prepare("UPDATE recurring_streams SET frequency = 'unknown', next_date = NULL WHERE stream_id = 's-tv'").run();
  const renamed = await send('PATCH', '/v1/recurring/s-tv', { name: 'Synthetic Wren' });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual([renamed.json().frequency, renamed.json().nextDate, renamed.json().monthlyCents], ['unknown', null, null]);
  assert.equal((await get('/v1/recurring')).monthlyTotalCents, 0);
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { frequency: 'unknown' })).statusCode, 400);
});

test('bill source fallback and matching refunds page in cursor order and average from the oldest month', async () => {
  const { get, send, db } = setup();
  const id = (await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' })).json().id as string;
  db.prepare("UPDATE transactions SET payee = 'Synthetic Wren' WHERE id = 'sub'").run();
  seedCategory(db, { id: 'c-synthetic', name: 'Synthetic Category' });
  for (const refund of ['refund-old', 'refund-new']) seedTxn(db, { id: refund, accountId: 'a1', date: '2026-01-10', amountCents: 100, payee: 'Synthetic Music', categoryId: 'c-synthetic' });
  const first = await get(`/v1/payee-history?recurringId=${id}&limit=1`);
  assert.deepEqual(first.rows.map((r: { transactionId: string }) => r.transactionId), ['sub']);
  assert.deepEqual([first.totalCents, first.averageCents], [899, 300]);
  const second = await get(`/v1/payee-history?recurringId=${id}&limit=1&cursor=${first.nextCursor}`);
  assert.deepEqual(second.rows.map((r: { transactionId: string }) => r.transactionId), ['refund-new']);
  const third = await get(`/v1/payee-history?recurringId=${id}&limit=1&cursor=${second.nextCursor}`);
  assert.deepEqual(third.rows.map((r: { transactionId: string }) => r.transactionId), ['refund-old']);
  assert.equal(third.nextCursor, null);
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

test('bill history: a Plaid stream lists its posted charges, other rows by exact name; a manual bill matches its text exactly', async () => {
  const { get, send, db } = setup();
  // imported before the bank cutover, still pending (under the owner's name for the bill), and a longer name a bill doesn't match
  seedTxn(db, { id: 'tv-old', accountId: 'a1', date: '2025-12-05', amountCents: -1500, payee: 'Synthetic TV', source: 'actual', sourceId: 'old' });
  seedTxn(db, { id: 'tv-pending', accountId: 'a1', date: '2026-03-09', amountCents: -1500, payee: 'Synthetic Telly', source: 'plaid', sourceId: 'tv-p', pending: true });
  seedTxn(db, { id: 'sub-club', accountId: 'a1', date: '2026-03-04', amountCents: -500, payee: 'Synthetic Music Club' });
  // only a split line carries the bill's name: payee History lists it, the bill (like Recurring) doesn't
  seedTxn(db, { id: 'sub-split', accountId: 'a1', date: '2026-03-01', amountCents: -700, payee: 'Synthetic Bakery' });
  seedSplit(db, { id: 'sub-split-a', transactionId: 'sub-split', amountCents: -700, categoryId: null, payee: 'Synthetic Music' });
  const id = (await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly', name: 'Synthetic Tunes' })).json().id as string;
  await send('PATCH', '/v1/recurring/s-tv', { name: 'Synthetic Telly' });
  assert.equal((await get('/v1/recurring')).items.some((i: object) => 'matchName' in i), false);
  const tv = await get('/v1/payee-history?recurringId=s-tv');
  assert.equal(tv.name, 'Synthetic Telly');
  assert.deepEqual(tv.rows.map((r: { transactionId: string; name: string }) => [r.transactionId, r.name]),
    [['tv-pending', 'Synthetic Telly'], ['tv-ach', 'SYNTHETIC ACH 0042'], ['tv', 'Synthetic TV'], ['tv-old', 'Synthetic TV']]);
  // before the first sync stores the stream's ids, every row goes by name
  db.prepare("UPDATE recurring_streams SET transaction_ids = '[]' WHERE stream_id = 's-tv'").run();
  assert.deepEqual((await get('/v1/payee-history?recurringId=s-tv')).rows.map((r: { transactionId: string }) => r.transactionId),
    ['tv-pending', 'tv-other', 'tv', 'tv-old']);
  const tunes = await get(`/v1/payee-history?recurringId=${id}`);
  assert.deepEqual([tunes.name, tunes.rows.map((r: { transactionId: string }) => r.transactionId)], ['Synthetic Tunes', ['sub']]);
  assert.deepEqual((await get('/v1/payee-history?name=Synthetic%20Music')).rows.map((r: { transactionId: string }) => r.transactionId),
    ['sub-club', 'sub', 'sub-split']);
  assert.equal((await get('/v1/payee-history?recurringId=nope')).code, 'NOT_FOUND');
  assert.equal((await get('/v1/payee-history?recurringId=s-tv&name=Synthetic%20TV')).code, 'INVALID_REQUEST');
  assert.equal((await get('/v1/payee-history')).code, 'INVALID_REQUEST');
});

test('mark a bill cancelled as of today; only a charge dated after that brings it back; unmark clears it', async () => {
  const { get, send, db } = setup();
  const endedOn = () => (db.prepare("SELECT ended_on FROM recurring_overrides WHERE stream_id = 's-tv'").get() as { ended_on: string | null }).ended_on;
  const item = async (id: string) => (await get('/v1/recurring')).items.find((i: { id: string }) => i.id === id);
  const tv = (await send('PATCH', '/v1/recurring/s-tv', { ended: true })).json();
  assert.deepEqual([tv.ended, tv.cancelled, tv.nextDate, endedOn()], [true, true, null, '2026-03-15']);
  const list = await get('/v1/recurring');
  assert.deepEqual([list.upcoming.length, list.monthlyTotalCents], [0, 0]);
  // a pending charge posting (or a date edit) up to the cancel day never revives it
  db.prepare("UPDATE recurring_streams SET last_date = '2026-03-12' WHERE stream_id = 's-tv'").run();
  assert.equal((await item('s-tv')).cancelled, true);
  db.prepare("UPDATE recurring_streams SET last_date = '2026-03-16' WHERE stream_id = 's-tv'").run();
  assert.deepEqual([(await item('s-tv')).ended, (await item('s-tv')).cancelled], [false, false]);
  // cancelling a bill charged after today keeps that charge's date
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { ended: true })).statusCode, 200);
  assert.equal(endedOn(), '2026-03-16');
  // an auto-ended bill is ended but not cancelled; unmarking a cancelled one leaves it ended by its missed charges
  db.prepare("UPDATE recurring_streams SET last_date = '2026-01-05' WHERE stream_id = 's-tv'").run();
  assert.deepEqual([(await item('s-tv')).ended, (await item('s-tv')).cancelled], [true, true]);
  const unmarked = (await send('PATCH', '/v1/recurring/s-tv', { ended: false })).json();
  assert.deepEqual([unmarked.ended, unmarked.cancelled, endedOn()], [true, false, null]);
  // an auto-ended bill comes back with a new charge
  db.prepare("UPDATE recurring_streams SET last_date = '2026-03-14' WHERE stream_id = 's-tv'").run();
  assert.equal((await item('s-tv')).ended, false);
  const id = (await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly' })).json().id as string;
  assert.equal((await send('PATCH', `/v1/recurring/${id}`, { ended: true })).json().ended, true);
  seedTxn(db, { id: 'sub-2', accountId: 'a1', date: '2026-03-15', amountCents: -1099, payee: 'Synthetic Music' });
  assert.equal((await item(id)).cancelled, true);
  seedTxn(db, { id: 'sub-3', accountId: 'a1', date: '2026-03-16', amountCents: -1099, payee: 'Synthetic Music' });
  assert.deepEqual([(await item(id)).ended, (await item(id)).lastDate], [false, '2026-03-16']);
  assert.equal((await send('PATCH', `/v1/recurring/${id}`, { ended: false })).json().ended, false);
});

test('a charge carries the bill whose History lists it: posted Plaid charges by stream id, other rows by exact name, a manual source while History falls back to it', async () => {
  const { get, send, db } = setup();
  seedCategory(db, { id: 'c-invest', name: 'Investment', isTransfer: true });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(db, { id: 'tv-xfer', accountId: 'a1', date: '2026-03-01', amountCents: -1500, categoryId: 'c-invest', payee: 'Synthetic TV' });
  seedTxn(db, { id: 'tv-uncat-xfer', accountId: 'a1', date: '2026-03-01', amountCents: -1500, plaidCategory: 'TRANSFER_OUT_ACCOUNT_TRANSFER', payee: 'Synthetic TV' });
  seedTxn(db, { id: 'tv-pend', accountId: 'a1', date: '2026-03-10', amountCents: -1500, payee: 'Synthetic TV', source: 'plaid', sourceId: 'tv-p', pending: true });
  seedTxn(db, { id: 'tv-refund', accountId: 'a1', date: '2026-03-11', amountCents: 1500, payee: 'Synthetic TV' });
  seedTxn(db, { id: 'tv-iou', accountId: 'a1', date: '2026-03-11', amountCents: -1500, payee: 'Synthetic TV', personId: 'p1' });
  const rec = async (id: string) => (await get(`/v1/transactions/${id}`)).recurring;
  const tv = { id: 's-tv', name: 'Synthetic TV', frequency: 'monthly' };
  assert.deepEqual(await rec('tv'), tv);
  assert.deepEqual(await rec('tv-ach'), tv);
  assert.deepEqual(await rec('tv-pend'), tv);
  // a posted charge outside the stream, another source's id clash, a refund and someone's IOU are never the bill's
  for (const id of ['tv-other', 'tv-card', 'tv-refund', 'tv-iou', 'sub']) assert.equal(await rec(id), null, id);
  // a transfer has no payee History, but its bill's History counts it, categorized or not
  assert.deepEqual([(await get('/v1/transactions/tv-xfer')).hasHistory, await rec('tv-xfer'), await rec('tv-uncat-xfer')], [true, tv, tv]);
  const id = (await send('POST', '/v1/recurring', { transactionId: 'sub', frequency: 'monthly', name: 'Synthetic Tunes' })).json().id as string;
  const tunes = { id, name: 'Synthetic Tunes', frequency: 'monthly' };
  assert.deepEqual(await rec('sub'), tunes);
  const page = (await get('/v1/transactions')).transactions as { id: string; recurring: unknown }[];
  assert.deepEqual(page.find((t) => t.id === 'sub')!.recurring, tunes);
  assert.deepEqual(page.find((t) => t.id === 'tv-ach')!.recurring, tv);
  // ended still counts; renamed away from the bill's text, the charge it was made from belongs while nothing else carries the text
  await send('PATCH', `/v1/recurring/${id}`, { ended: true });
  db.prepare("UPDATE transactions SET payee = 'Synthetic Renamed' WHERE id = 'sub'").run();
  assert.deepEqual(await rec('sub'), tunes);
  seedTxn(db, { id: 'sub-2', accountId: 'a1', date: '2026-03-12', amountCents: -1099, payee: 'Synthetic Music' });
  assert.deepEqual([await rec('sub'), await rec('sub-2')], [null, tunes]);
  // every charge that names a bill is in that bill's History
  const all = (await get('/v1/transactions?limit=200')).transactions as { id: string; recurring: { id: string } | null }[];
  assert.ok(all.filter((t) => t.recurring).length >= 6);
  for (const t of all.filter((x) => x.recurring)) {
    const h = await get(`/v1/payee-history?recurringId=${t.recurring!.id}&limit=200`);
    assert.ok(h.rows.some((r: { transactionId: string }) => r.transactionId === t.id), `${t.id} in ${t.recurring!.id}`);
  }
  await send('PATCH', '/v1/recurring/s-tv', { hidden: true });
  assert.equal(await rec('tv'), null);
});

test('a stream Plaid stops listing stays as ended, still holding its charges; a manual twin comes back', async () => {
  const { get, send, db } = setup();
  db.prepare("UPDATE recurring_streams SET is_active = 0 WHERE stream_id = 's-tv'").run();
  const item = (await get('/v1/recurring')).items.find((i: { id: string }) => i.id === 's-tv');
  assert.deepEqual([item.ended, item.cancelled, item.stopped, item.nextDate], [true, false, true, null]);
  assert.equal((await get('/v1/recurring')).upcoming.length, 0);
  assert.equal((await get('/v1/transactions/tv')).recurring.id, 's-tv');
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES ('man-tv', 'Synthetic TV', 'synthetic tv', 'monthly', 'tv-other', 'x')").run();
  assert.deepEqual((await get('/v1/recurring')).items.filter((i: { name: string }) => i.name === 'Synthetic TV').map((i: { id: string; ended: boolean }) => [i.id, i.ended]),
    [['s-tv', true], ['man-tv', false]]);
  // a live twin wins a name match over the stopped stream; the stream keeps its own charges by id
  assert.deepEqual([(await get('/v1/transactions/tv-other')).recurring.id, (await get('/v1/transactions/tv')).recurring.id], ['man-tv', 's-tv']);
  assert.equal((await send('PATCH', '/v1/recurring/s-tv', { ended: true })).json().cancelled, true);
});
