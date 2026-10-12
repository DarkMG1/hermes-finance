import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAccountEstimate } from '../src/backfill.ts';
import { getNetWorth } from '../src/networth.ts';
import { makeTestDeps, seedAccount } from './helpers.ts';
import type { Db } from '../src/db.ts';

function securities(db: Db): void {
  const sec = db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, ?, ?, 'seed')");
  sec.run('sa', 'Synthetic A Fund', 'SYNA', 'etf', 0);
  sec.run('sb', 'Synthetic B Corp', 'SYNB', 'equity', 0);
  sec.run('sc', 'Synthetic Private Note', null, 'fixed income', 0);
  sec.run('cash', 'Synthetic Dollar', null, 'cash', 1);
}
const anchor = (db: Db, account: string, holdings: [string, number, number][]) => {
  db.prepare("INSERT INTO holding_syncs (account_id, date) VALUES (?, '2026-03-15')").run(account);
  for (const [sec, qty, cents] of holdings) {
    db.prepare("INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES (?, ?, '2026-03-15', ?, ?)").run(account, sec, qty, cents);
  }
};
const txn = (db: Db, id: string, account: string, sec: string | null, date: string, qty: number, amountCents: number, priceCents: number | null, subtype = 'buy') =>
  db.prepare('INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, price_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, account, sec, date, subtype.includes('split') ? 'transfer' : 'buy', subtype, qty, amountCents, priceCents, 's');
const price = (db: Db, ticker: string, date: string, closeCents: number, split = 1) =>
  db.prepare('INSERT INTO security_prices (ticker, date, close_cents, split_factor) VALUES (?, ?, ?, ?)').run(ticker, date, closeCents, split);

function buyAndDeposit(db: Db): void {
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 115000 });
  securities(db);
  anchor(db, 'inv', [['sa', 10, 110000], ['cash', 5000, 5000]]);
  txn(db, 'b1', 'inv', 'sa', '2026-03-12', 4, 40000, 10000);
  txn(db, 'd1', 'inv', null, '2026-03-10', 0, -30000, null, 'deposit');
  for (const [d, c] of [['2026-03-09', 9500], ['2026-03-10', 9600], ['2026-03-12', 10000], ['2026-03-13', 10500], ['2026-03-14', 10800]] as const) {
    price(db, 'SYNA', d, c);
  }
}

test('shares and cash walk back from the anchor day; missing days carry the last close', () => {
  const { deps } = makeTestDeps();
  buyAndDeposit(deps.db);
  const est = loadAccountEstimate(deps.db, 'inv')!;
  assert.equal(est.anchor, '2026-03-15');
  assert.equal(est.earliest, '2026-03-10');
  const total = (d: string) => est.valueOn(d).totalCents;
  assert.deepEqual(['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'].map(total),
    [72000, 102600, 102600, 105000, 110000, 113000]);
  assert.equal(est.valueOn('2026-03-11').cashCents, 45000);
  assert.equal(est.valueOn('2026-03-11').bySecurity.get('sa'), 57600);
});

test('splits are counted once, whether or not Plaid records them', () => {
  for (const recorded of [false, true]) {
    const { deps } = makeTestDeps();
    const { db } = deps;
    seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 200000 });
    securities(db);
    anchor(db, 'inv', [['sb', 20, 200000]]);
    txn(db, 'b1', 'inv', 'sb', '2026-03-11', 5, 100000, 20000);
    if (recorded) txn(db, 's1', 'inv', 'sb', '2026-03-13', 10, 0, null, 'stock split');
    for (const [d, c, f] of [['2026-03-10', 19600, 1], ['2026-03-11', 20000, 1], ['2026-03-12', 20200, 1], ['2026-03-13', 10100, 2], ['2026-03-14', 10000, 1]] as const) {
      price(db, 'SYNB', d, c, f);
    }
    const est = loadAccountEstimate(db, 'inv')!;
    assert.deepEqual(['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'].map((d) => est.valueOn(d).totalCents),
      [198000, 200000, 202000, 202000, 200000], `recorded=${recorded}`);
  }
});

test('without prices: the last Plaid trade price, then the anchor price', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 18000 });
  securities(db);
  anchor(db, 'inv', [['sc', 3, 18000]]);
  txn(db, 'b1', 'inv', 'sc', '2026-03-12', 2, 10000, 5000);
  const est = loadAccountEstimate(db, 'inv')!;
  assert.deepEqual(['2026-03-11', '2026-03-12', '2026-03-14'].map((d) => est.valueOn(d).totalCents), [16000, 15000, 15000]);
});

test('a position sold before the anchor still counts before its sale', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 5000 });
  securities(db);
  anchor(db, 'inv', [['cash', 5000, 5000]]);
  txn(db, 's1', 'inv', 'sa', '2026-03-12', -2, -20000, 10000, 'sell');
  price(db, 'SYNA', '2026-03-11', 9900);
  const est = loadAccountEstimate(db, 'inv')!;
  // before the sale: 2 shares at 99 and 200 less cash
  assert.equal(est.valueOn('2026-03-11').totalCents, 2 * 9900 + 5000 - 20000);
  assert.equal(est.valueOn('2026-03-12').totalCents, 5000);
});

test('an account without transactions stays flat', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 110000 });
  securities(db);
  anchor(db, 'inv', [['sa', 10, 110000]]);
  const est = loadAccountEstimate(db, 'inv')!;
  assert.equal(est.earliest, '2026-03-15');
  assert.equal(est.valueOn('2026-03-14').totalCents, 110000, 'no price: anchor price');
  price(db, 'SYNA', '2026-03-13', 10000);
  assert.equal(loadAccountEstimate(db, 'inv')!.valueOn('2026-03-14').totalCents, 100000, 'shares constant, prices move');
});

test('no holdings sync: no estimate', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'inv', type: 'investment', balanceCents: 1 });
  assert.equal(loadAccountEstimate(deps.db, 'inv'), null);
});

test('net worth and investments history reach back through the estimate', () => {
  const { deps } = makeTestDeps();
  buyAndDeposit(deps.db);
  seedAccount(deps.db, { id: 'chk', balanceCents: 1000 });
  deps.db.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES ('inv', '2026-03-15', 115000), ('chk', '2026-03-15', 1000)").run();
  const inv = getNetWorth(deps.db, 'all', '2026-03-15', { type: 'investment' });
  assert.deepEqual(inv.points.map((p) => [p.date, p.netWorthCents]), [
    ['2026-03-10', 102600], ['2026-03-11', 102600], ['2026-03-12', 105000], ['2026-03-13', 110000], ['2026-03-14', 113000], ['2026-03-15', 115000],
  ]);
  assert.equal(inv.estimatedThrough, '2026-03-14');
  const all = getNetWorth(deps.db, 'all', '2026-03-15');
  assert.equal(all.points[0]!.netWorthCents, 102600 + 1000, 'checking held flat, investments estimated');
  assert.deepEqual(getNetWorth(deps.db, 'all', '2026-03-15', { type: 'investment', accountIds: ['nope'] }).points, []);
});

test('a cash distribution moves cash only and never prices the position at 0', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 23000 });
  securities(db);
  anchor(db, 'inv', [['sc', 3, 18000], ['cash', 5000, 5000]]);
  txn(db, 'b1', 'inv', 'sc', '2026-03-11', 1, 5000, 5000);
  txn(db, 'dv', 'inv', 'sc', '2026-03-13', 0, -300, 0, 'distribution');
  const est = loadAccountEstimate(db, 'inv')!;
  // H: 3 sh, cash 5000; no closes, so the last real trade (5000 on 03-11) prices sc, not the distribution's 0
  // 03-14, 03-13: 3×5000 + 5000 = 20000. 03-12, 03-11: undo distribution → cash 4700 → 15000 + 4700 = 19700.
  // 03-10 (< earliest 03-11): undo buy → 2 sh, cash 9700; no trade ≤ 03-10 → anchor price 6000 → 12000 + 9700 = 21700
  assert.deepEqual(['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'].map((d) => est.valueOn(d).totalCents),
    [21700, 19700, 19700, 20000, 20000]);
  assert.equal(est.valueOn('2026-03-12').cashCents, 4700);
  assert.equal(est.valueOn('2026-03-14').bySecurity.get('sc'), 15000);
});

test('a transaction on a cash security changes neither shares nor cash', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 115000 });
  securities(db);
  anchor(db, 'inv', [['sa', 10, 110000], ['cash', 5000, 5000]]);
  txn(db, 'sw', 'inv', 'cash', '2026-03-13', 1000, 1000, 100);
  price(db, 'SYNA', '2026-03-12', 10000);
  const est = loadAccountEstimate(db, 'inv')!;
  // the sweep is ignored: earliest stays H; 03-12 and 03-14: 10×10000 + 5000 = 105000 (counted, 03-12 would be 106000)
  assert.equal(est.earliest, '2026-03-15');
  assert.deepEqual(['2026-03-12', '2026-03-14'].map((d) => est.valueOn(d).totalCents), [105000, 105000]);
});

test('holdings anchored before the first balance snapshot: the anchor value holds until it', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 116000 });
  securities(db);
  db.prepare("INSERT INTO holding_syncs (account_id, date) VALUES ('inv', '2026-03-13')").run();
  const hs = db.prepare("INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES ('inv', ?, '2026-03-13', ?, ?)");
  hs.run('sa', 10, 100000);
  hs.run('cash', 5000, 5000);
  txn(db, 'b1', 'inv', 'sa', '2026-03-12', 4, 40000, 10000);
  for (const [d, c] of [['2026-03-11', 9500], ['2026-03-13', 10200], ['2026-03-14', 10400]] as const) price(db, 'SYNA', d, c);
  db.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES ('inv', '2026-03-15', 116000)").run();
  // H = 03-13, S = 03-15. anchor value = 10 × (100000/10) + 5000 = 105000 on 03-13 and 03-14
  // (walked-back state would give 6×10200 + 45000 = 106200 and 6×10400 + 45000 = 107400).
  // 03-12 (= earliest, buy not undone): 10 × 9500 (close 03-11) + 5000 = 100000. 03-15: snapshot 116000.
  const h = getNetWorth(db, 'all', '2026-03-15', { type: 'investment' });
  assert.deepEqual(h.points.map((p) => [p.date, p.netWorthCents]),
    [['2026-03-12', 100000], ['2026-03-13', 105000], ['2026-03-14', 105000], ['2026-03-15', 116000]]);
  assert.equal(h.estimatedThrough, '2026-03-14');
});

test('an account filter sums only the chosen accounts', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  buyAndDeposit(db);
  seedAccount(db, { id: 'inv2', type: 'investment', balanceCents: 50000 });
  anchor(db, 'inv2', [['sb', 5, 50000]]);
  txn(db, 'b2', 'inv2', 'sb', '2026-03-12', 1, 8000, 8000);
  db.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES ('inv', '2026-03-15', 115000), ('inv2', '2026-03-15', 50000)").run();
  const pts = (ids: string[]) => getNetWorth(db, 'all', '2026-03-15', { type: 'investment', accountIds: ids }).points.map((p) => [p.date, p.netWorthCents]);
  // inv alone: as in buyAndDeposit
  assert.deepEqual(pts(['inv']), [
    ['2026-03-10', 102600], ['2026-03-11', 102600], ['2026-03-12', 105000], ['2026-03-13', 110000], ['2026-03-14', 113000], ['2026-03-15', 115000],
  ]);
  // inv2 alone: H 5 sh (anchor price 10000), no closes. 03-12..03-14: last trade 8000 → 40000. 03-15: snapshot 50000
  assert.deepEqual(pts(['inv2']), [['2026-03-12', 40000], ['2026-03-13', 40000], ['2026-03-14', 40000], ['2026-03-15', 50000]]);
  // both, 03-10: inv 102600 + inv2 fully undone (4 sh × anchor 10000 + cash 8000 = 48000) = 150600
  assert.equal(pts(['inv', 'inv2'])[0]![1], 150600);
});

test('a range window that starts inside the estimate', () => {
  const { deps } = makeTestDeps();
  buyAndDeposit(deps.db);
  deps.db.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES ('inv', '2026-03-15', 115000)").run();
  // today 04-12, 1m → window starts 03-12: first point 105000 (buyAndDeposit 03-12), last 115000 carried from 03-15
  const h = getNetWorth(deps.db, '1m', '2026-04-12', { type: 'investment' });
  assert.deepEqual(h.points[0], { date: '2026-03-12', netWorthCents: 105000 });
  assert.deepEqual(h.points.at(-1), { date: '2026-04-12', netWorthCents: 115000 });
  assert.equal(h.points.length, 32);
  assert.equal(h.changeCents, 10000);
  assert.equal(h.estimatedThrough, '2026-03-14');
});
