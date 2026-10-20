import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reimbursements } from '@hermes/shared';
import { buildApp } from '../src/app.ts';
import { makeTestDeps, AUTH, seedAccount, seedCategory, seedTxn, seedSplit, seedPerson } from './helpers.ts';

// Out for March 2026: Fun 3500, Food 2400, Uncategorized 1200, Gift -400 = 6700. In: 200000 + 8000 = 208000.
function setup() {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedCategory(db, { id: 'c-fun', name: 'Fun' });
  seedCategory(db, { id: 'c-gift', name: 'Gift' });
  seedCategory(db, { id: 'c-pay', name: 'Pay', isIncome: true });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(db, { id: 't1', accountId: 'a1', date: '2026-03-20', amountCents: -1000, categoryId: 'c-food', payee: 'Synthetic Market' });
  seedTxn(db, { id: 't2', accountId: 'a1', date: '2026-03-19', amountCents: 300, categoryId: 'c-food', payee: 'Synthetic Refund' });
  seedTxn(db, { id: 't3', accountId: 'a1', date: '2026-03-18', amountCents: -4000, payee: 'Synthetic Store' });
  seedSplit(db, { id: 't3-a', transactionId: 't3', amountCents: -2500, categoryId: 'c-fun', payee: 'Synthetic Lamp' });
  seedSplit(db, { id: 't3-b', transactionId: 't3', amountCents: -1500, categoryId: null, personId: 'p1' });
  // the bank changed the amount after the split: 300 is a split difference
  seedTxn(db, { id: 't4', accountId: 'a1', date: '2026-03-18', amountCents: -2300, payee: 'Synthetic Diner' });
  seedSplit(db, { id: 't4-a', transactionId: 't4', amountCents: -1000, categoryId: 'c-food' });
  seedSplit(db, { id: 't4-b', transactionId: 't4', amountCents: -1000, categoryId: 'c-fun' });
  seedTxn(db, { id: 't5', accountId: 'a1', date: '2026-03-15', amountCents: 200000, categoryId: 'c-pay', payee: 'Synthetic Employer' });
  seedTxn(db, { id: 't6', accountId: 'a1', date: '2026-03-14', amountCents: 10000, payee: 'Synthetic Bonus' });
  seedSplit(db, { id: 't6-a', transactionId: 't6', amountCents: 8000, categoryId: 'c-pay' });
  seedSplit(db, { id: 't6-b', transactionId: 't6', amountCents: 2000, categoryId: null, personId: 'p1' });
  seedTxn(db, { id: 't7', accountId: 'a1', date: '2026-03-13', amountCents: -500, personId: 'p1', payee: 'Synthetic Theirs' });
  seedTxn(db, { id: 't8', accountId: 'manual', date: '2026-03-12', amountCents: -700, categoryId: 'c-food', payee: 'Synthetic Paid', paidByPersonId: 'p1' });
  seedTxn(db, { id: 't9', accountId: 'a1', date: '2026-03-11', amountCents: -900, source: 'plaid', sourceId: 's9', plaidCategory: 'FOOD_AND_DRINK_RESTAURANT', payee: 'Synthetic Grill' });
  seedTxn(db, { id: 't10', accountId: 'a1', date: '2026-03-10', amountCents: -5000, categoryId: 'c-xfer', payee: 'Synthetic Card' });
  seedTxn(db, { id: 't11', accountId: 'a1', date: '2026-04-02', amountCents: -100, categoryId: 'c-food', payee: 'Synthetic April' });
  seedTxn(db, { id: 't12', accountId: 'a1', date: '2026-03-09', amountCents: -800, categoryId: 'c-food', removedAt: 'x' });
  seedTxn(db, { id: 't13', accountId: 'a1', date: '2026-03-08', amountCents: 400, categoryId: 'c-gift', payee: 'Synthetic Return' });
  return { deps, app: buildApp(deps) };
}
type Row = { transactionId: string; lineId: string | null; name: string; categoryId: string | null; categoryName: string; amountCents: number; isSplit: boolean; isSplitDifference: boolean };

async function allRows(app: ReturnType<typeof buildApp>, query: string, limit: number): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  do {
    const url: string = `/v1/expenses?${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: 'GET', url, headers: AUTH });
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json() as { rows: Row[]; nextCursor: string | null };
    out.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}
const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.amountCents, 0);

test('spending reports In, Out and Net; totalCents stays equal to Out', async () => {
  const { app } = setup();
  const s = (await app.inject({ method: 'GET', url: '/v1/spending?period=month&date=2026-03', headers: AUTH })).json();
  assert.deepEqual([s.inCents, s.outCents, s.netCents, s.totalCents], [208000, 6700, 201300, 6700]);
  assert.deepEqual(s.categories.map((c: { name: string; spentCents: number }) => [c.name, c.spentCents]),
    [['Fun', 3500], ['Food', 2400], ['Uncategorized', 1200], ['Gift', -400]]);
});

test('every list sums to its total, for every category, Out and In, month and year, across pages', async () => {
  const { app } = setup();
  for (const period of ['period=month&date=2026-03', 'period=year&date=2026']) {
    const s = (await app.inject({ method: 'GET', url: `/v1/spending?${period}`, headers: AUTH })).json();
    assert.equal(sum(await allRows(app, period, 2)), s.outCents, `${period} out`);
    assert.equal(sum(await allRows(app, `${period}&kind=in`, 2)), s.inCents, `${period} in`);
    for (const c of s.categories as { categoryId: string | null; spentCents: number }[]) {
      assert.equal(sum(await allRows(app, `${period}&categoryId=${c.categoryId ?? 'uncategorized'}`, 2)), c.spentCents, `${period} ${c.categoryId}`);
    }
  }
});

test('expense rows: split lines are their own rows with their own names; other people and transfers never appear', async () => {
  const { app } = setup();
  const rows = await allRows(app, 'period=month&date=2026-03', 50);
  const lamp = rows.find((r) => r.lineId === 't3-a')!;
  assert.deepEqual([lamp.transactionId, lamp.name, lamp.categoryName, lamp.amountCents, lamp.isSplit, lamp.isSplitDifference],
    ['t3', 'Synthetic Lamp', 'Fun', 2500, true, false]);
  const drift = rows.find((r) => r.transactionId === 't4' && r.isSplitDifference)!;
  assert.deepEqual([drift.lineId, drift.name, drift.categoryId, drift.categoryName, drift.amountCents, drift.isSplit], [null, 'Synthetic Diner', null, 'Uncategorized', 300, true]);
  assert.equal(rows.find((r) => r.lineId === 't4-a')!.name, 'Synthetic Diner', "an unnamed line shows the transaction's payee");
  assert.equal(rows.find((r) => r.transactionId === 't2')!.amountCents, -300, 'a refund is a negative row');
  const ids = new Set(rows.map((r) => r.lineId ?? r.transactionId));
  for (const absent of ['t3-b', 't6-a', 't6-b', 't5', 't7', 't10', 't11', 't12']) assert.ok(!ids.has(absent), absent);
  assert.ok(ids.has('t8'), "a row someone else paid is the owner's spending");
  const income = await allRows(app, 'period=month&date=2026-03&kind=in', 50);
  assert.deepEqual(income.map((r) => [r.lineId ?? r.transactionId, r.amountCents]), [['t5', 200000], ['t6-a', 8000]]);
});

test('paging one row at a time walks the same rows in the same order', async () => {
  const { app } = setup();
  const key = (r: Row) => `${r.transactionId}/${r.lineId}/${r.isSplitDifference}`;
  const full = (await allRows(app, 'period=month&date=2026-03', 200)).map(key);
  assert.deepEqual((await allRows(app, 'period=month&date=2026-03', 1)).map(key), full);
  // t3 and t4 share a date and created_at; t4 was inserted later, so it comes first; its difference follows its lines
  assert.deepEqual(full.slice(0, 6), ['t1/null/false', 't2/null/false', 't4/t4-a/false', 't4/t4-b/false', 't4/null/true', 't3/t3-a/false'],
    'newest first; lines in entry order');
});

test('a month with income and no spending still reports In', async () => {
  const { deps, app } = setup();
  deps.db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id NOT IN ('t5')").run();
  const s = (await app.inject({ method: 'GET', url: '/v1/spending?period=month&date=2026-03', headers: AUTH })).json();
  assert.deepEqual([s.inCents, s.outCents, s.netCents, s.categories.length], [200000, 0, 200000, 0]);
});

test('expenses rejects a bad cursor, a date that does not match the period, and unknown fields', async () => {
  const { app } = setup();
  const get = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/expenses?${q}`, headers: AUTH })).statusCode;
  assert.equal(await get('period=month&date=2026-03&cursor=bogus'), 400);
  assert.equal(await get('period=month&date=2026'), 400);
  assert.equal(await get('period=year&date=2026-03'), 400);
  assert.equal(await get('period=month&date=2026-03&kind=sideways'), 400);
  assert.equal(await get('period=month&date=2026-03&extra=1'), 400);
});

test('moving a split line to someone else takes it out of Expenses and its category', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'PATCH', url: '/v1/transactions/t3/lines/t3-a', headers: { ...AUTH, 'idempotency-key': 'k-move' }, payload: { personId: 'p1' } });
  assert.equal(res.statusCode, 200, res.body);
  const rows = await allRows(app, 'period=month&date=2026-03', 50);
  assert.equal(rows.some((r) => r.lineId === 't3-a'), false);
  const s = (await app.inject({ method: 'GET', url: '/v1/spending?period=month&date=2026-03', headers: AUTH })).json();
  assert.equal(s.categories.find((c: { name: string }) => c.name === 'Fun').spentCents, 1000);
  assert.equal(s.outCents, 4200);
});

test('reimbursements: twelve months of Reimbursement lines, charges out and paybacks in, newest first', async () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1' });
  seedCategory(db, { id: 'c-reimb', name: 'Reimbursements', isTransfer: true });
  seedCategory(db, { id: 'c-xfer', name: 'Transfer', isTransfer: true });
  seedCategory(db, { id: 'c-food', name: 'Food' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  const row = (id: string, date: string, amountCents: number, more: { categoryId?: string; personId?: string; removedAt?: string } = { categoryId: 'c-reimb' }) =>
    seedTxn(db, { id, accountId: 'a1', date, amountCents, payee: `Synthetic ${id}`, ...more });
  row('r1', '2026-03-02', -5000);
  row('r2', '2026-03-10', 3000);
  row('r3', '2026-02-01', -2000, {});
  seedSplit(db, { id: 'r3-a', transactionId: 'r3', amountCents: -1200, categoryId: 'c-reimb', payee: 'Synthetic Hotel' });
  seedSplit(db, { id: 'r3-b', transactionId: 'r3', amountCents: -800, categoryId: 'c-food' });
  row('r4', '2026-02-20', 1200);
  row('r5', '2025-03-31', -999); // before the window
  row('r6', '2026-03-03', -100, { personId: 'p1' });
  row('r7', '2026-03-04', -100, { categoryId: 'c-reimb', removedAt: 'x' });
  row('r8', '2026-03-05', -100, { categoryId: 'c-xfer' });
  const app = buildApp(deps);
  const r = (await app.inject({ method: 'GET', url: '/v1/reimbursements', headers: AUTH })).json() as Reimbursements;
  Reimbursements.parse(r);
  assert.equal(r.months.length, 12);
  assert.deepEqual(r.months.slice(0, 3), [
    { month: '2026-03', outCents: 5000, inCents: 3000, unpaidCents: 2000 },
    { month: '2026-02', outCents: 1200, inCents: 1200, unpaidCents: 0 },
    { month: '2026-01', outCents: 0, inCents: 0, unpaidCents: 0 }]);
  assert.equal(r.months[11]!.month, '2025-04');
  assert.deepEqual(r.rows, [
    { transactionId: 'r2', lineId: null, date: '2026-03-10', name: 'Synthetic r2', amountCents: 3000 },
    { transactionId: 'r1', lineId: null, date: '2026-03-02', name: 'Synthetic r1', amountCents: -5000 },
    { transactionId: 'r4', lineId: null, date: '2026-02-20', name: 'Synthetic r4', amountCents: 1200 },
    { transactionId: 'r3', lineId: 'r3-a', date: '2026-02-01', name: 'Synthetic Hotel', amountCents: -1200 }]);
});
