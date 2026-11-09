import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { buildLots, planSale, type Lot } from '../src/tax/lots.ts';
import { AUTH, makeTestDeps, seedAccount } from './helpers.ts';

const AS_OF = '2026-03-15';

function setup() {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const db = deps.db;
  let n = 0;
  const get = async (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': `k${(n += 1)}` }, ...(payload ? { payload } : {}) });
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  security(db, 'sx', 'SYNA');
  return { db, get, send };
}

function security(db: Db, id: string, ticker: string | null, isCash = false) {
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, ?, ?, 'x')")
    .run(id, `Synthetic ${id}`, ticker, isCash ? 'cash' : 'etf', isCash ? 1 : 0);
}

/** Plaid's sign convention, as stored: a buy has quantity > 0 and amount > 0 (cash leaves the account); a sell has quantity < 0 and
 *  amount < 0 (cash comes in). Callers pass shares and dollars-in-cents as positive numbers. */
let seq = 0;
function buy(db: Db, account: string, sec: string, date: string, quantity: number, costCents: number, subtype = 'buy') {
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, 'x')")
    .run(`b${(seq += 1)}`, account, sec, date, subtype, quantity, costCents);
  return `b${seq}`;
}
function sell(db: Db, account: string, sec: string, date: string, quantity: number, proceedsCents: number) {
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, ?, ?, 'sell', 'sell', ?, ?, 'x')")
    .run(`s${(seq += 1)}`, account, sec, date, -quantity, -proceedsCents);
}
function holding(db: Db, account: string, sec: string, quantity: number, basisCents: number | null) {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES (?, ?, ?, 1, 1, ?, 'x')")
    .run(account, sec, quantity, basisCents);
}

/** 10 shares at $100, then 10 at $120; 12 sold. FIFO leaves 8 of the $120 lot ($960), HIFO 8 of the $100 lot ($800). */
function twoLotsOneSale(db: Db, basisCents: number) {
  buy(db, 'brk', 'sx', '2024-03-01', 10, 100000);
  buy(db, 'brk', 'sx', '2024-06-01', 10, 120000);
  sell(db, 'brk', 'sx', '2025-03-02', 12, 180000);
  holding(db, 'brk', 'sx', 8, basisCents);
}
const brief = (s: { date: string; quantity: number; proceedsCents: number; costCents: number; acquiredOn: string | null; term: string }) =>
  [s.date, s.quantity, s.proceedsCents, s.costCents, s.acquiredOn, s.term];

test('FIFO matches the oldest lots; term is long after one year and a day', () => {
  const { db } = setup();
  twoLotsOneSale(db, 96000);
  // sold exactly one year after: still short-term
  security(db, 'sy', 'SYNB');
  buy(db, 'brk', 'sy', '2024-03-01', 1, 5000);
  sell(db, 'brk', 'sy', '2025-03-01', 1, 6000);
  const r = buildLots(db, AS_OF);
  assert.equal(r.methods.brk, 'fifo');
  assert.equal(r.inferred.brk, true);
  assert.deepEqual(r.sales.filter((s) => s.securityId === 'sx').map(brief), [
    ['2025-03-02', 10, 150000, 100000, '2024-03-01', 'long'],
    ['2025-03-02', 2, 30000, 24000, '2024-06-01', 'short'],
  ]);
  assert.deepEqual(r.sales.filter((s) => s.securityId === 'sy').map(brief), [['2025-03-01', 1, 6000, 5000, '2024-03-01', 'short']]);
  assert.ok(r.sales.every((s) => s.taxable && s.washDisallowedCents === 0 && s.accountId === 'brk'));
  assert.deepEqual(r.lots.map((l) => [l.securityId, l.ticker, l.acquiredOn, l.quantity, l.costCents, l.status]), [['sx', 'SYNA', '2024-06-01', 8, 96000, 'known']]);
});

test("HIFO is inferred when it reproduces the holding's cost basis and FIFO doesn't", () => {
  const { db } = setup();
  twoLotsOneSale(db, 80000);
  const r = buildLots(db, AS_OF);
  assert.deepEqual([r.methods.brk, r.inferred.brk], ['hifo', true]);
  assert.deepEqual(r.sales.map(brief), [
    ['2025-03-02', 10, 150000, 120000, '2024-06-01', 'short'],
    ['2025-03-02', 2, 30000, 20000, '2024-03-01', 'long'],
  ]);
  assert.deepEqual(r.lots.map((l) => [l.acquiredOn, l.quantity, l.costCents]), [['2024-03-01', 8, 80000]]);
});

test('an owner-set method wins over inference', async () => {
  const { db, get, send } = setup();
  twoLotsOneSale(db, 80000);
  const set = await send('PATCH', '/v1/accounts/brk/lot-method', { method: 'fifo' });
  assert.deepEqual([set.statusCode, set.json()], [200, { accountId: 'brk', method: 'fifo' }]);
  const r = (await get('/v1/tax/lots')).json();
  assert.deepEqual([r.methods.brk, r.inferred.brk], ['fifo', false]);
  assert.deepEqual(r.lots.map((l: Lot) => [l.acquiredOn, l.quantity, l.costCents]), [['2024-06-01', 8, 96000]]);
  // clearing it goes back to the inferred method
  await send('PATCH', '/v1/accounts/brk/lot-method', { method: null });
  assert.deepEqual([buildLots(db, AS_OF).methods.brk, buildLots(db, AS_OF).inferred.brk], ['hifo', true]);
  assert.equal((await send('PATCH', '/v1/accounts/brk/lot-method', { method: 'lifo' })).statusCode, 400);
  assert.equal((await send('PATCH', '/v1/accounts/nope/lot-method', { method: 'fifo' })).statusCode, 404);
  seedAccount(db, { id: 'chk', type: 'depository', subtype: 'checking' });
  assert.equal((await send('PATCH', '/v1/accounts/chk/lot-method', { method: 'fifo' })).statusCode, 404);
});

test('holdings before the history become one unverified lot (quantity and cost = holding minus known lots)', () => {
  const { db } = setup();
  holding(db, 'brk', 'sx', 15, 200000);
  buy(db, 'brk', 'sx', '2025-01-10', 5, 50000);
  // 2 of the shares held before the history were sold: their date and cost are unknown, so no gain is counted for them
  sell(db, 'brk', 'sx', '2025-02-01', 2, 30000);
  const r = buildLots(db, AS_OF);
  assert.deepEqual(r.sales.map(brief), [['2025-02-01', 2, 30000, 30000, null, 'unknown']]);
  assert.deepEqual(r.lots.map((l) => [l.status, l.acquiredOn, l.quantity, l.costCents]), [['unverified', null, 10, 150000], ['known', '2025-01-10', 5, 50000]]);
});

test('an entered lot replaces the unverified remainder', async () => {
  const { db, get, send } = setup();
  holding(db, 'brk', 'sx', 15, 200000);
  const b = buy(db, 'brk', 'sx', '2025-01-10', 5, 50000);
  const whole = await send('POST', '/v1/tax/lots', { accountId: 'brk', securityId: 'sx', acquiredOn: '2020-05-01', quantity: 10, costCents: 140000 });
  assert.equal(whole.statusCode, 201);
  assert.deepEqual((await get('/v1/tax/lots')).json().lots.map((l: Lot) => [l.id, l.status, l.acquiredOn, l.quantity, l.costCents]),
    [[whole.json().id, 'entered', '2020-05-01', 10, 140000], [b, 'known', '2025-01-10', 5, 50000]]);
  assert.equal((await send('DELETE', `/v1/tax/lots/${whole.json().id}`)).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/tax/lots/${whole.json().id}`)).statusCode, 404);
  await send('POST', '/v1/tax/lots', { accountId: 'brk', securityId: 'sx', acquiredOn: '2020-05-01', quantity: 4, costCents: 60000 });
  assert.deepEqual(buildLots(db, AS_OF).lots.map((l) => [l.status, l.quantity, l.costCents]), [['unverified', 6, 90000], ['entered', 4, 60000], ['known', 5, 50000]]);
  const bad = async (body: object) => (await send('POST', '/v1/tax/lots', { accountId: 'brk', securityId: 'sx', acquiredOn: '2020-05-01', quantity: 1, costCents: 1, ...body })).json().field;
  assert.equal(await bad({ accountId: 'nope' }), 'accountId');
  assert.equal(await bad({ securityId: 'nope' }), 'securityId');
  assert.equal(await bad({ quantity: 0 }), 'quantity');
  assert.equal(await bad({ acquiredOn: '1999-12-31' }), 'acquiredOn');
});

test('a loss sale with a buy of the same security within 30 days before or after has its loss disallowed and added to the replacement lot', () => {
  const { db } = setup();
  // after: 4 of the 10 shares sold at a $300 loss are bought back 19 days later
  buy(db, 'brk', 'sx', '2025-01-02', 10, 100000);
  buy(db, 'brk', 'sx', '2025-04-30', 1, 7000);
  sell(db, 'brk', 'sx', '2025-06-01', 10, 70000);
  buy(db, 'brk', 'sx', '2025-06-20', 4, 28000);
  buy(db, 'brk', 'sx', '2025-07-02', 1, 7000);
  // before: 3 shares bought 12 days ahead of a loss sale of an older lot
  security(db, 'sz', 'SYNZ');
  buy(db, 'brk', 'sz', '2025-01-02', 10, 100000);
  buy(db, 'brk', 'sz', '2025-05-20', 3, 21000);
  sell(db, 'brk', 'sz', '2025-06-01', 10, 70000);
  // a bigger buy splits: only the 2 replacement shares carry the loss and the holding period
  security(db, 'sw', 'SYNW');
  buy(db, 'brk', 'sw', '2025-01-02', 2, 20000);
  sell(db, 'brk', 'sw', '2025-06-01', 2, 14000);
  buy(db, 'brk', 'sw', '2025-06-05', 5, 35000);
  const r = buildLots(db, AS_OF);
  assert.deepEqual(r.sales.map((s) => [s.securityId, s.costCents, s.proceedsCents, s.washDisallowedCents]).sort(),
    [['sw', 20000, 14000, 6000], ['sx', 100000, 70000, 12000], ['sz', 100000, 70000, 9000]]);
  // the replacement carries the disallowed loss and the sold shares' 150-day holding period; buys 31+ days away are untouched
  assert.deepEqual(r.lots.map((l) => [l.securityId, l.acquiredOn, l.quantity, l.costCents]), [
    ['sw', '2025-01-06', 2, 20000],
    ['sw', '2025-06-05', 3, 21000],
    ['sx', '2025-01-21', 4, 40000],
    ['sx', '2025-04-30', 1, 7000],
    ['sx', '2025-07-02', 1, 7000],
    ['sz', '2024-12-21', 3, 30000],
  ]);
});

test('roth buy washes a taxable loss; roth sale is not realized', () => {
  const { db } = setup();
  security(db, 'sx2', 'syna');
  buy(db, 'brk', 'sx', '2025-01-02', 10, 100000);
  sell(db, 'brk', 'sx', '2025-06-01', 10, 70000);
  buy(db, 'roth', 'sx2', '2025-06-10', 5, 35000);
  sell(db, 'roth', 'sx2', '2025-08-01', 2, 12000);
  const r = buildLots(db, AS_OF);
  assert.deepEqual(r.sales.map((s) => [s.accountId, s.taxable, s.washDisallowedCents]), [['brk', true, 15000], ['roth', false, 0]]);
  // the loss is lost for good: an IRA's basis doesn't move
  assert.deepEqual(r.lots.map((l) => [l.accountId, l.quantity, l.costCents]), [['roth', 3, 21000]]);
});

test('cash rows make no lots', () => {
  const { db } = setup();
  security(db, 'mm', null, true);
  const row = db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, 'brk', ?, '2025-02-01', ?, ?, ?, ?, 'x')");
  row.run('c1', null, 'cash', 'deposit', 0, -500000);
  row.run('c2', null, 'fee', 'management fee', 0, 1200);
  row.run('c3', null, 'transfer', 'transfer', 0, -10000);
  row.run('c4', 'sx', 'cash', 'synthetic payout', 0, -2500);
  row.run('c5', 'mm', 'buy', 'buy', 100, 10000);
  row.run('c6', 'mm', 'sell', 'sell', -40, -4000);
  holding(db, 'brk', 'mm', 60, 6000);
  const r = buildLots(db, AS_OF);
  assert.deepEqual([r.lots, r.sales], [[], []]);
});

test('partial sales of fractional lots leave no dust', () => {
  const { db } = setup();
  const costs = [[0.1, 1009], [0.2, 2011], [0.0217, 131, 'synthetic reinvestment'], [1.0217, 10141], [0.3333, 3347]] as const;
  costs.forEach(([q, c, sub], i) => buy(db, 'brk', 'sx', `2025-01-0${i + 1}`, q, c, sub));
  sell(db, 'brk', 'sx', '2025-02-01', 0.3, 9001);
  sell(db, 'brk', 'sx', '2025-02-02', 0.5217, 10001);
  sell(db, 'brk', 'sx', '2025-02-03', 0.5217, 10003);
  holding(db, 'brk', 'sx', 0.3333, null);
  const r = buildLots(db, AS_OF);
  assert.ok(r.lots.every((l) => l.quantity >= 1e-6), JSON.stringify(r.lots));
  assert.ok(r.lots.every((l) => l.status === 'known'));
  assert.equal(r.sales.reduce((a, s) => a + s.costCents, 0) + r.lots.reduce((a, l) => a + l.costCents, 0), costs.reduce((a, [, c]) => a + c, 0));
  assert.equal(r.sales.reduce((a, s) => a + s.proceedsCents, 0), 9001 + 10001 + 10003);
  assert.ok(Math.abs(r.lots.reduce((a, l) => a + l.quantity, 0) - 0.3333) < 1e-9);
  assert.ok(r.sales.every((s) => s.term === 'short' && s.quantity >= 1e-6));
});

test('planSale blocks when any taken lot is unverified', () => {
  const lot = (id: string, status: Lot['status'], acquiredOn: string | null, quantity: number, costCents: number, accountId = 'brk'): Lot =>
    ({ id, accountId, securityId: 'sx', ticker: 'SYNA', acquiredOn, quantity, costCents, status });
  const lots = [lot('k2', 'known', '2025-01-01', 4, 60000), lot('u', 'unverified', null, 5, 0), lot('k1', 'known', '2024-01-01', 3, 30000), lot('o', 'known', '2020-01-01', 9, 1, 'roth')];
  const take = (r: ReturnType<typeof planSale>) => [r.taken.map((t) => [t.id, t.takeQuantity]), r.blocked !== null];
  assert.deepEqual(take(planSale(lots, 'fifo', 'brk', 'sx', 2)), [[['u', 2]], true]);
  assert.deepEqual(take(planSale(lots, 'hifo', 'brk', 'sx', 2)), [[['u', 2]], true]);
  assert.deepEqual(take(planSale(lots, 'fifo', 'brk', 'sx', 7)), [[['u', 5], ['k1', 2]], true]);
  assert.deepEqual(take(planSale(lots, 'specific', 'brk', 'sx', 5, ['k2', 'k1'])), [[['k2', 4], ['k1', 1]], false]);
  assert.deepEqual(take(planSale(lots, 'specific', 'brk', 'sx', 8, ['k2', 'k1'])), [[['k2', 4], ['k1', 3]], true]);
  const known = lots.filter((l) => l.status === 'known');
  assert.deepEqual(take(planSale(known, 'fifo', 'brk', 'sx', 4)), [[['k1', 3], ['k2', 1]], false]);
  assert.deepEqual(take(planSale(known, 'hifo', 'brk', 'sx', 4)), [[['k2', 4]], false]);
  // only the specific method lets the owner pick
  assert.deepEqual(take(planSale(known, 'fifo', 'brk', 'sx', 4, ['k2'])), [[['k1', 3], ['k2', 1]], false]);
  assert.deepEqual(take(planSale(known, 'fifo', 'brk', 'sx', 8)), [[['k1', 3], ['k2', 4]], true]);
});
