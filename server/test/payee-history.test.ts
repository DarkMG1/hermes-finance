import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayeeHistory } from '@hermes/shared';
import { buildApp } from '../src/app.ts';
import { getTransaction } from '../src/ledger.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedPerson, seedSplit, seedTxn } from './helpers.ts';

// Test clock is 2026-03-15, so the window is 2025-04 … 2026-03.
function setup() {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(db, { id: 'h1', accountId: 'a1', date: '2026-03-10', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Market #123' });
  // split with a roommate: the owner's line counts, the full charge is reported
  seedTxn(db, { id: 'h2', accountId: 'a1', date: '2026-02-05', amountCents: -4000, payee: 'SYNTHETIC*MARKET' });
  seedSplit(db, { id: 'h2-a', transactionId: 'h2', amountCents: -2500, categoryId: 'c-food' });
  seedSplit(db, { id: 'h2-b', transactionId: 'h2', amountCents: -1500, categoryId: null, personId: 'p1' });
  seedTxn(db, { id: 'h3', accountId: 'a1', date: '2026-02-20', amountCents: 300, categoryId: 'c-food', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'h4', accountId: 'a1', date: '2026-01-10', amountCents: -700, personId: 'p1', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'h5', accountId: 'a1', date: '2026-01-11', amountCents: -5000, categoryId: 'c-xfer', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'h6', accountId: 'a1', date: '2026-01-12', amountCents: -800, categoryId: 'c-food', payee: 'Synthetic Market', removedAt: 'x' });
  // the bank changed the amount after the split: the 300 difference counts too
  seedTxn(db, { id: 'h7', accountId: 'a1', date: '2026-01-15', amountCents: -2300, payee: 'Synthetic Market' });
  seedSplit(db, { id: 'h7-a', transactionId: 'h7', amountCents: -1000, categoryId: 'c-food' });
  seedSplit(db, { id: 'h7-b', transactionId: 'h7', amountCents: -1000, categoryId: 'c-food' });
  // renamed payee still matches on the merchant name; outside the chart window but in the list
  seedTxn(db, { id: 'h8', accountId: 'a1', date: '2024-12-01', amountCents: -999, categoryId: 'c-food', payee: 'Synthetic Old', merchantName: 'Synthetic Market' });
  seedTxn(db, { id: 'h9', accountId: 'a1', date: '2026-03-11', amountCents: -400, categoryId: 'c-food', payee: 'Synthetic Other' });
  // the owner's line has its own payee: the row is still titled by the name that matched
  seedTxn(db, { id: 'h10', accountId: 'a1', date: '2024-11-01', amountCents: -3000, payee: 'Synthetic Market' });
  seedSplit(db, { id: 'h10-a', transactionId: 'h10', amountCents: -1800, categoryId: 'c-food', payee: 'Synthetic Tires' });
  seedSplit(db, { id: 'h10-b', transactionId: 'h10', amountCents: -1200, categoryId: null, personId: 'p1' });
  // only a split line's own payee matches: the share counts, but the Warehouse charge isn't this payee's total
  seedTxn(db, { id: 'h11', accountId: 'a1', date: '2024-10-01', amountCents: -4000, payee: 'Synthetic Warehouse' });
  seedSplit(db, { id: 'h11-a', transactionId: 'h11', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Market' });
  seedSplit(db, { id: 'h11-b', transactionId: 'h11', amountCents: -3000, categoryId: null, personId: 'p1' });
  // dated after today: listed as upcoming, out of the months even though it's this month
  seedTxn(db, { id: 'h12', accountId: 'a1', date: '2026-03-20', amountCents: -500, categoryId: 'c-food', payee: 'Synthetic Market' });
  seedTxn(db, { id: 'g1', accountId: 'a1', date: '2026-03-01', amountCents: -100, categoryId: 'c-food', payee: 'SYNTHETIC GROVE MARKET' });
  seedTxn(db, { id: 'g2', accountId: 'a1', date: '2026-03-02', amountCents: -200, categoryId: 'c-food', payee: 'Synthetic Grove' });
  seedTxn(db, { id: 'g3', accountId: 'a1', date: '2026-03-03', amountCents: -300, categoryId: 'c-food', payee: 'Synthetic Groves' });
  const app = buildApp(deps);
  return (name: string, extra = '') => app.inject({ method: 'GET', url: `/v1/payee-history?name=${encodeURIComponent(name)}${extra}`, headers: AUTH });
}

test('payee history: owner share, refunds net, drift counts, person/transfer/removed rows excluded', async () => {
  const res = await setup()('synthetic market');
  assert.equal(res.statusCode, 200, res.body);
  const h = res.json();
  assert.equal(h.name, 'synthetic market');
  assert.deepEqual(h.rows.map((r: { transactionId: string; shareCents: number; totalCents: number | null }) => [r.transactionId, r.shareCents, r.totalCents]),
    [['h12', 500, null], ['h1', 1000, null], ['h3', -300, null], ['h2', 2500, 4000], ['h7', 2300, null], ['h8', 999, null], ['h10', 1800, 3000], ['h11', 1000, null]]);
  assert.deepEqual(h.rows.map((r: { upcoming: boolean }) => r.upcoming), [true, false, false, false, false, false, false, false]);
  assert.equal(h.rows[1].name, 'Synthetic Market #123');
  assert.equal(h.rows[6].name, 'Synthetic Market');
  assert.equal(h.rows[7].name, 'Synthetic Market');
  assert.equal(h.nextCursor, null);
  assert.equal(h.months.length, 12);
  assert.deepEqual(h.months[0], { month: '2025-04', cents: 0 });
  assert.deepEqual(h.months.slice(9), [{ month: '2026-01', cents: 2300 }, { month: '2026-02', cents: 2200 }, { month: '2026-03', cents: 1000 }]);
  assert.deepEqual([h.totalCents, h.averageCents], [5500, 458]);
});

test('payee history: a name with nothing to match is 400 NO_NAME; a missing name is 400', async () => {
  const get = setup();
  const empty = await get('#123456');
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().code, 'NO_NAME');
  assert.equal((await get('Synthetic Nobody')).json().rows.length, 0);
  const app = buildApp(makeTestDeps().deps);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/payee-history', headers: AUTH })).statusCode, 400);
});

test('payee history: whole-word prefix, one direction only', async () => {
  const get = setup();
  const ids = async (name: string) => (await get(name)).json().rows.map((r: { transactionId: string; name: string }) => [r.transactionId, r.name]);
  assert.deepEqual(await ids('Synthetic Grove'), [['g2', 'Synthetic Grove'], ['g1', 'SYNTHETIC GROVE MARKET']]);
  assert.deepEqual(await ids('Synthetic Grove Market'), [['g1', 'SYNTHETIC GROVE MARKET']]);
});

test('payee history: pages rows by cursor; months and totals cover the whole window on every page', async () => {
  const get = setup();
  const full = (await get('synthetic market')).json();
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = (await get('synthetic market', `&limit=3${cursor ? `&cursor=${cursor}` : ''}`)).json() as PayeeHistory;
    assert.ok(page.rows.length <= 3);
    assert.deepEqual([page.months, page.totalCents, page.averageCents], [full.months, full.totalCents, full.averageCents]);
    seen.push(...page.rows.map((r) => r.transactionId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, full.rows.map((r: { transactionId: string }) => r.transactionId));
  assert.equal((await get('synthetic market', '&cursor=nope')).statusCode, 400);
  assert.equal((await get('synthetic market', '&limit=201')).statusCode, 400);
});

test('payee history: a split names its row by the first matching line, every time', async () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  // the bank amount moved after the split: the drift row (bank name) ties with the lines on date and rowid
  seedTxn(deps.db, { id: 's1', accountId: 'a1', date: '2026-03-01', amountCents: -3000, payee: 'Synthetic Deli' });
  seedSplit(deps.db, { id: '02-b', transactionId: 's1', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Deli Two' });
  seedSplit(deps.db, { id: '01-a', transactionId: 's1', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Deli One' });
  const app = buildApp(deps);
  const res = await app.inject({ method: 'GET', url: '/v1/payee-history?name=Synthetic%20Deli', headers: AUTH });
  assert.deepEqual(res.json().rows.map((r: { name: string; shareCents: number }) => [r.name, r.shareCents]), [['Synthetic Deli One', 3000]]);
});

test('payee history: a 2000-character name is read; 2001 is 400', async () => {
  const get = setup();
  assert.equal((await get(`Synthetic ${'x'.repeat(1990)}`)).statusCode, 200);
  assert.equal((await get(`Synthetic ${'x'.repeat(1991)}`)).statusCode, 400);
});

test('hasHistory: a name to match, not an unsplit IOU, not raw bank text alone', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(db, { id: 'digits', accountId: 'a1', date: '2026-03-01', amountCents: -100, payee: '7-11' });
  seedTxn(db, { id: 'number', accountId: 'a1', date: '2026-03-01', amountCents: -100, payee: '#123456' });
  seedTxn(db, { id: 'iou', accountId: 'a1', date: '2026-03-01', amountCents: -100, payee: 'Synthetic Cafe', personId: 'p1' });
  seedTxn(db, { id: 'split', accountId: 'a1', date: '2026-03-01', amountCents: -100, payee: 'Synthetic Cafe', personId: 'p1' });
  seedSplit(db, { id: 'split-a', transactionId: 'split', amountCents: -100, categoryId: null });
  seedTxn(db, { id: 'raw', accountId: 'a1', date: '2026-03-01', amountCents: -100, bankDescription: 'SYNTHETIC POS PURCHASE', source: 'plaid', sourceId: 'raw' });
  seedTxn(db, { id: 'merchant', accountId: 'a1', date: '2026-03-01', amountCents: -100, bankDescription: 'SYNTHETIC POS PURCHASE', merchantName: 'Synthetic Cafe' });
  seedTxn(db, { id: 'renamed', accountId: 'a1', date: '2026-03-01', amountCents: -100, bankDescription: 'SYNTHETIC POS PURCHASE', payee: 'Synthetic Cafe' });
  assert.deepEqual(['digits', 'number', 'iou', 'split', 'raw', 'merchant', 'renamed'].map((id) => getTransaction(db, id)!.hasHistory),
    [true, false, false, true, false, true, true]);
});
