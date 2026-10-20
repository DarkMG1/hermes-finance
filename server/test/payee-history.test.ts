import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayeeHistory } from '@hermes/shared';
import { buildApp } from '../src/app.ts';
import { getTransaction, listTransactions } from '../src/ledger.ts';
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

test('hasHistory: only on a row that counts as spending', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedCategory(db, { id: 'c-pay', name: 'Paycheck', isIncome: true });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  const row = (id: string, amountCents: number, more: { categoryId?: string; plaidCategory?: string }) =>
    seedTxn(db, { id, accountId: 'a1', date: '2026-03-01', amountCents, payee: 'Synthetic Corp', ...more });
  row('income', 50000, { categoryId: 'c-pay' });
  row('transfer', -50000, { categoryId: 'c-xfer' });
  row('card-payment', -50000, { plaidCategory: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  row('inflow', 50000, {});
  row('refund', 500, { categoryId: 'c-food' });
  assert.deepEqual(['income', 'transfer', 'card-payment', 'inflow', 'refund'].map((id) => getTransaction(db, id)!.hasHistory),
    [false, false, false, false, true]);
});

test('hasHistory: a listed page matches the per-transaction values', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  seedTxn(db, { id: 'x1', accountId: 'a1', date: '2026-03-01', amountCents: -100, categoryId: 'c-food', payee: 'Synthetic Cafe' });
  seedTxn(db, { id: 'x2', accountId: 'a1', date: '2026-03-05', amountCents: -100, categoryId: 'c-xfer', payee: 'Synthetic Cafe' });
  seedTxn(db, { id: 'x3', accountId: 'a1', date: '2026-03-09', amountCents: -100, categoryId: 'c-food', payee: 'Synthetic Cafe' });
  seedTxn(db, { id: 'x4', accountId: 'a1', date: '2026-03-09', amountCents: -100, bankDescription: 'SYNTHETIC POS PURCHASE' });
  const page = listTransactions(db, { limit: 50 }).transactions;
  assert.equal(page.length, 4);
  assert.deepEqual(page.map((t) => t.hasHistory), page.map((t) => getTransaction(db, t.id)!.hasHistory));
  assert.deepEqual(page.filter((t) => t.hasHistory).map((t) => t.id).sort(), ['x1', 'x3']);
});

test('payee history: month narrows the rows only; average spans the months since the first charge', async () => {
  const get = setup();
  const full = (await get('synthetic market')).json() as PayeeHistory;
  const feb = (await get('synthetic market', '&month=2026-02')).json() as PayeeHistory;
  assert.deepEqual(feb.rows.map((r) => r.transactionId), ['h3', 'h2']);
  assert.deepEqual([feb.months, feb.totalCents, feb.averageCents], [full.months, full.totalCents, full.averageCents]);
  assert.equal((await get('synthetic market', '&month=2026-13')).statusCode, 400);
  // every Grove charge is this month: the average is the month itself, not a twelfth
  const grove = (await get('Synthetic Grove')).json() as PayeeHistory;
  assert.deepEqual([grove.totalCents, grove.averageCents], [300, 300]);
});

test('payee history: bank text adds charges not renamed from it; reimbursed charges count and are marked, paybacks and fronted lines do not', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedCategory(db, { id: 'c-soft', name: 'Software' });
  seedCategory(db, { id: 'c-reimb', name: 'Reimbursement', isTransfer: true });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  const row = (id: string, date: string, payee: string | undefined, bankDescription: string, categoryId: string | null, amountCents = -2000) =>
    seedTxn(db, { id, accountId: 'a1', date, amountCents, payee, bankDescription, categoryId: categoryId ?? undefined });
  row('o1', '2026-03-01', 'Synthetic AI', 'SAI*CHAT SUBSCR', 'c-reimb');
  row('o2', '2026-02-20', undefined, 'SAI*CHAT  SUBSCR', 'c-soft');
  row('o3', '2026-02-10', 'SAI*CHAT SUBSCR', 'SAI*CHAT SUBSCR', 'c-soft');
  row('o4', '2026-02-01', 'Chat Plan', 'SAI*CHAT SUBSCR', 'c-soft');
  row('o5', '2026-01-20', undefined, 'SAI*CHAT SUBSCR 9999', 'c-soft');
  row('o6', '2026-01-15', 'Synthetic AI', 'SAI*API', 'c-soft');
  row('o7', '2026-01-10', 'Synthetic AI', 'SAI*CHAT SUBSCR', 'c-xfer');
  row('o8', '2026-03-05', 'Synthetic AI', 'SYNTHETIC PAYROLL', 'c-reimb', 2000);
  // the owner fronted the rest for someone, filed under Reimbursement: only the owner's own line counts
  row('o9', '2026-01-05', 'Synthetic AI', 'SAI*TEAM', null, -3000);
  seedSplit(db, { id: 'o9-a', transactionId: 'o9', amountCents: -1000, categoryId: 'c-soft' });
  seedSplit(db, { id: 'o9-b', transactionId: 'o9', amountCents: -2000, categoryId: 'c-reimb' });
  const app = buildApp(deps);
  const get = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/payee-history?${q}`, headers: AUTH })).json() as PayeeHistory;
  const h = await get(`name=Synthetic%20AI&bank=${encodeURIComponent('SAI*CHAT SUBSCR')}`);
  assert.deepEqual(h.rows.map((r) => [r.transactionId, r.name, r.shareCents, r.reimbursed]), [
    ['o1', 'Synthetic AI', 2000, true], ['o2', 'SAI*CHAT  SUBSCR', 2000, false], ['o3', 'SAI*CHAT SUBSCR', 2000, false],
    ['o6', 'Synthetic AI', 2000, false], ['o9', 'Synthetic AI', 1000, false]]);
  // first charge in January, one this month: averaged over three months
  assert.deepEqual([h.totalCents, h.averageCents], [9000, 3000]);
  assert.deepEqual((await get('name=Synthetic%20AI')).rows.map((r) => r.transactionId), ['o1', 'o6', 'o9']);
  assert.deepEqual(['o1', 'o7', 'o8'].map((id) => getTransaction(db, id)!.hasHistory), [true, false, false]);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/payee-history?recurringId=x&bank=y', headers: AUTH })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/payee-history?name=x&bank=', headers: AUTH })).statusCode, 400);
});

test('payee history: no charge yet this month averages through last month; a month pages by cursor', async () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  for (const [id, date] of [['y1', '2026-01-05'], ['y2', '2026-02-05'], ['y3', '2026-02-06'], ['y4', '2026-02-07']] as const) {
    seedTxn(deps.db, { id, accountId: 'a1', date, amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Gym' });
  }
  const app = buildApp(deps);
  const get = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/payee-history?name=Synthetic%20Gym${q}`, headers: AUTH })).json() as PayeeHistory;
  assert.deepEqual([(await get('')).totalCents, (await get('')).averageCents], [4000, 2000]);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: PayeeHistory = await get(`&month=2026-02&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...page.rows.map((r) => r.transactionId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['y4', 'y3', 'y2']);
});

test('payee history: a manual bill whose charge was renamed falls back to that charge, as Recurring does', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-soft', name: 'Software' });
  seedCategory(db, { id: 'c-reimb', name: 'Reimbursement', isTransfer: true });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  seedTxn(db, { id: 'src', accountId: 'a1', date: '2026-03-01', amountCents: -2500, categoryId: 'c-soft', payee: 'Synthetic New Cloud' });
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, hidden, created_at) VALUES ('man-1', 'Synthetic Hosting', 'synthetic cloud', 'monthly', 'src', 0, 'x')").run();
  const app = buildApp(deps);
  const h = (await app.inject({ method: 'GET', url: '/v1/payee-history?recurringId=man-1', headers: AUTH })).json() as PayeeHistory;
  assert.deepEqual(h.rows.map((r) => [r.transactionId, r.shareCents]), [['src', 2500]]);
  const bill = async () => (await app.inject({ method: 'GET', url: '/v1/payee-history?recurringId=man-1', headers: AUTH })).json() as PayeeHistory;
  // a transfer with the bill's name ends the fallback in Recurring, so here too; a bill counts its transfers
  seedTxn(db, { id: 'x1', accountId: 'a1', date: '2026-02-15', amountCents: -2500, categoryId: 'c-xfer', payee: 'Synthetic Cloud' });
  assert.deepEqual((await bill()).rows.map((r) => r.transactionId), ['x1']);
  // a reimbursed charge with the bill's name is in the bill's History, marked
  seedTxn(db, { id: 'm2', accountId: 'a1', date: '2026-02-01', amountCents: -2500, categoryId: 'c-reimb', payee: 'Synthetic Cloud' });
  assert.deepEqual((await bill()).rows.map((r) => [r.transactionId, r.reimbursed]), [['x1', false], ['m2', true]]);
});

test('payee history: a bill counts every charge for it, transfers included; a payee still leaves transfers out', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-invest', name: 'Investment', isTransfer: true });
  seedTxn(db, { id: 'b1', accountId: 'a1', date: '2026-03-01', amountCents: -5000, categoryId: 'c-invest', payee: 'Synthetic Broker' });
  seedTxn(db, { id: 'b2', accountId: 'a1', date: '2026-02-01', amountCents: -5000, categoryId: 'c-invest', payee: 'Synthetic Broker' });
  // money back from the broker is not a charge
  seedTxn(db, { id: 'b3', accountId: 'a1', date: '2026-02-10', amountCents: 900, categoryId: 'c-invest', payee: 'Synthetic Broker' });
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES ('man-b', 'Synthetic Broker', 'synthetic broker', 'monthly', 'b1', 'x')").run();
  const app = buildApp(deps);
  const get = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/payee-history?${q}`, headers: AUTH })).json() as PayeeHistory;
  const bill = await get('recurringId=man-b');
  assert.deepEqual(bill.rows.map((r) => r.transactionId), ['b1', 'b2']);
  assert.deepEqual([bill.totalCents, bill.averageCents, bill.months.slice(10).map((m) => m.cents), bill.names], [10000, 5000, [5000, 5000], []]);
  assert.deepEqual((await get('name=Synthetic%20Broker')).rows, []);
});

test('payee history: a row someone else paid shows the whole receipt when that is more than the share', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  const paid = (id: string, amountCents: number) =>
    seedTxn(db, { id, accountId: 'a1', date: '2026-03-05', amountCents, categoryId: 'c-food', payee: 'Synthetic Bistro', paidByPersonId: 'p1' });
  const receipt = db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at, tax_cents, tip_cents, fees_cents) VALUES (?, ?, 3, 'x', ?, ?, NULL)");
  const item = db.prepare("INSERT INTO receipt_items (id, transaction_id, position, name, amount_cents, people) VALUES (?, ?, ?, 'Synthetic Dish', ?, '[\"me\"]')");
  paid('pb1', -1500);
  receipt.run('pb1', Buffer.from([0xff, 0xd8, 0xff]), 200, 300);
  item.run('i1', 'pb1', 0, 1500);
  item.run('i2', 'pb1', 1, 2000);
  paid('pb2', -800); // no items
  paid('pb3', -5000); // items no more than the share
  item.run('i3', 'pb3', 0, 5000);
  const app = buildApp(deps);
  const h = (await app.inject({ method: 'GET', url: '/v1/payee-history?name=Synthetic%20Bistro', headers: AUTH })).json() as PayeeHistory;
  assert.deepEqual(h.rows.map((r) => [r.transactionId, r.shareCents, r.totalCents]), [['pb3', 5000, null], ['pb2', 800, null], ['pb1', 1500, 4000]]);
  assert.equal(h.totalCents, 7300);
});

test('payee history: the owner leaves a longer name out of a payee; it and the names it starts go, the name stays listed', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  const row = (id: string, date: string, amountCents: number, payee: string) => seedTxn(db, { id, accountId: 'a1', date, amountCents, categoryId: 'c-food', payee });
  row('e1', '2026-03-01', -1000, 'Synthetic Club');
  row('e2', '2026-03-02', -4000, 'SYNTHETIC CLUB GAS #12');
  row('e3', '2026-02-03', -500, 'Synthetic Club Gas');
  row('e4', '2026-03-04', -700, 'Synthetic Club Deli');
  row('e5', '2026-03-05', -300, 'Synthetic Club Gas Station');
  const app = buildApp(deps);
  const get = async (extra = '') => (await app.inject({ method: 'GET', url: `/v1/payee-history?name=synthetic%20club${extra}`, headers: AUTH })).json() as PayeeHistory;
  const put = (payload: object) => app.inject({ method: 'PUT', url: '/v1/payee-history/exclusions', headers: AUTH, payload });
  const gas = { name: 'Synthetic Club Gas Station', excluded: false };
  assert.deepEqual((await get()).names, [gas, { name: 'Synthetic Club Deli', excluded: false }, { name: 'SYNTHETIC CLUB GAS #12', excluded: false }]);
  for (let i = 0; i < 2; i += 1) assert.equal((await put({ name: 'Synthetic Club', excludedName: 'synthetic club gas', excluded: true })).statusCode, 204);
  const h = await get();
  // "club gas" takes "club gas station" with it, out of the rows and the names
  assert.deepEqual([h.rows.map((r) => r.transactionId), h.totalCents], [['e4', 'e1'], 1700]);
  assert.deepEqual(h.names, [{ name: 'Synthetic Club Deli', excluded: false }, { name: 'SYNTHETIC CLUB GAS #12', excluded: true }]);
  // names ignore the month; rows and paging follow it
  const feb = await get('&month=2026-02');
  assert.deepEqual([feb.rows, feb.names], [[], h.names]);
  const first = await get('&month=2026-03&limit=1');
  assert.deepEqual([first.rows.map((r) => r.transactionId), first.names], [['e4'], h.names]);
  assert.deepEqual((await get(`&month=2026-03&limit=1&cursor=${first.nextCursor}`)).rows.map((r) => r.transactionId), ['e1']);
  // a longer payee is its own History: the exclusion belongs to Synthetic Club only
  assert.equal((await (await app.inject({ method: 'GET', url: '/v1/payee-history?name=Synthetic%20Club%20Gas', headers: AUTH })).json()).rows.length, 3);
  // putting back a longer name lifts the shorter exclusion that hid it
  assert.equal((await put({ name: 'Synthetic Club', excludedName: 'Synthetic Club Gas Station', excluded: false })).statusCode, 204);
  assert.equal((await get()).rows.length, 5);
  assert.equal((await put({ name: '#123456', excludedName: 'Synthetic Club Gas', excluded: true })).json().code, 'NO_NAME');
  assert.equal((await put({ name: 'Synthetic Club', excludedName: '***', excluded: true })).json().code, 'NO_NAME');
  const own = await put({ name: 'Synthetic Club', excludedName: 'SYNTHETIC CLUB #9', excluded: true });
  assert.deepEqual([own.statusCode, own.json().code], [400, 'INVALID_REQUEST']);
  assert.equal((await put({ name: 'Synthetic Club', excludedName: 'x', excluded: true, extra: 1 })).statusCode, 400);
  assert.equal((await put({ name: 'Synthetic Club', excludedName: 'x'.repeat(2001), excluded: true })).statusCode, 400);
});

test('payee history: names list only longer spellings of the payee, never bank-text titles; exclusions never touch a bill', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-soft', name: 'Software' });
  seedTxn(db, { id: 'n1', accountId: 'a1', date: '2026-03-01', amountCents: -1000, categoryId: 'c-soft', payee: 'Synthetic Cloud Plus' });
  // matched only by its bank text, titled by text with nothing to match
  seedTxn(db, { id: 'n2', accountId: 'a1', date: '2026-03-02', amountCents: -1000, categoryId: 'c-soft', bankDescription: '#12345' });
  seedTxn(db, { id: 'n3', accountId: 'a1', date: '2026-03-03', amountCents: -1000, categoryId: 'c-soft', merchantName: 'Synthetic Vendor', bankDescription: '#12345' });
  db.prepare("INSERT INTO history_exclusions VALUES ('synthetic cloud', 'synthetic cloud plus')").run();
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES ('man', 'Synthetic Cloud Plus', 'synthetic cloud plus', 'monthly', 'n1', 'x')").run();
  const app = buildApp(deps);
  const get = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/payee-history?${q}`, headers: AUTH })).json() as PayeeHistory;
  const h = await get('name=Synthetic%20Cloud&bank=%2312345');
  assert.deepEqual([h.rows.map((r) => r.transactionId), h.names], [['n3', 'n2'], [{ name: 'Synthetic Cloud Plus', excluded: true }]]);
  const bill = await get('recurringId=man');
  assert.deepEqual([bill.rows.map((r) => r.transactionId), bill.names], [['n1'], []]);
});
