import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAccountEstimate } from '../src/backfill.ts';
import { getNetWorth } from '../src/networth.ts';
import { getHoldingHistory } from '../src/investments.ts';
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
const txn = (db: Db, id: string, account: string, sec: string | null, date: string, qty: number, amountCents: number, priceCents: number | null, subtype = 'buy',
  type = subtype.includes('split') ? 'transfer' : 'buy') =>
  db.prepare('INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, price_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, account, sec, date, type, subtype, qty, amountCents, priceCents, 's');
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

test('unpriced positions are excluded instead of using trade or anchor prices', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 18000 });
  securities(db);
  anchor(db, 'inv', [['sc', 3, 18000]]);
  txn(db, 'b1', 'inv', 'sc', '2026-03-12', 2, 10000, 5000);
  const est = loadAccountEstimate(db, 'inv')!;
  assert.deepEqual(['2026-03-11', '2026-03-12', '2026-03-14'].map((d) => est.valueOn(d).totalCents), [10000, 0, 0]);
  assert.deepEqual([...est.valueOn('2026-03-12').excluded], ['sc']);
  assert.equal(est.valueOn('2026-03-15').totalCents, 18000);
  assert.equal(est.valueOn('2026-03-15').excluded.size, 0);
});

test('a supported fund without cached price history is excluded too', () => {
  const { deps: { db } } = makeTestDeps();
  buyAndDeposit(db);
  db.prepare('DELETE FROM security_prices').run();
  const value = loadAccountEstimate(db, 'inv')!.valueOn('2026-03-12');
  assert.equal(value.totalCents, 5000);
  assert.deepEqual([...value.excluded], ['sa']);
  assert.equal(value.bySecurity.has('sa'), false);
});

test('a supported fund is excluded before its first cached close despite trade and anchor prices', () => {
  const { deps: { db } } = makeTestDeps();
  buyAndDeposit(db);
  db.prepare("DELETE FROM security_prices WHERE date < '2026-03-13'").run();
  const est = loadAccountEstimate(db, 'inv')!;
  for (const [day, cash] of [['2026-03-11', 45000], ['2026-03-12', 5000]] as const) {
    const value = est.valueOn(day);
    assert.equal(value.totalCents, cash);
    assert.equal(value.bySecurity.has('sa'), false);
    assert.deepEqual([...value.excluded], ['sa']);
  }
  assert.equal(est.valueOn('2026-03-13').bySecurity.get('sa'), 105000);
  db.prepare("INSERT INTO balance_snapshots VALUES ('inv', '2026-03-15', 115000)").run();
  const history = getNetWorth(db, 'all', '2026-03-15', { type: 'investment' });
  assert.deepEqual(history.excluded, { through: '2026-03-12', positions: 1 });
  assert.deepEqual(history.points.map((p) => p.netWorthCents), [45000, 45000, 5000, 110000, 113000, 115000]);
  assert.deepEqual(getNetWorth(db, 'all', '2026-03-15'), history);
  assert.deepEqual(getHoldingHistory(db, 'SYNA', 'all', '2026-03-15')!.points.map((p) => p.date),
    ['2026-03-13', '2026-03-14', '2026-03-15']);
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

test('an account without transactions keeps its positions and needs historical prices', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 110000 });
  securities(db);
  anchor(db, 'inv', [['sa', 10, 110000]]);
  const est = loadAccountEstimate(db, 'inv')!;
  assert.equal(est.earliest, '2026-03-15');
  assert.equal(est.valueOn('2026-03-14').totalCents, 0, 'no historical price: excluded');
  assert.deepEqual([...est.valueOn('2026-03-14').excluded], ['sa']);
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
  anchor(db, 'inv', [['sb', 3, 18000], ['cash', 5000, 5000]]);
  price(db, 'SYNB', '2026-03-10', 6000);
  price(db, 'SYNB', '2026-03-11', 5000);
  price(db, 'SYNB', '2026-03-15', 6000);
  txn(db, 'b1', 'inv', 'sb', '2026-03-11', 1, 5000, 5000);
  txn(db, 'dv', 'inv', 'sb', '2026-03-13', 0, -300, 0, 'distribution', 'cash');
  const est = loadAccountEstimate(db, 'inv')!;
  // H: 3 sh, cash 5000; cached closes price sb, not the distribution's 0
  // 03-14, 03-13: 3×5000 + 5000 = 20000. 03-12, 03-11: undo distribution → cash 4700 → 15000 + 4700 = 19700.
  // 03-10 (< earliest 03-11): undo buy → 2 sh at close 6000, cash 9700 → 12000 + 9700 = 21700
  assert.deepEqual(['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'].map((d) => est.valueOn(d).totalCents),
    [21700, 19700, 19700, 20000, 20000]);
  assert.equal(est.valueOn('2026-03-12').cashCents, 4700);
  assert.equal(est.valueOn('2026-03-14').bySecurity.get('sb'), 15000);
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

test('cash and fee rows with fractional quantities never move fund shares', () => {
  for (const type of ['cash', 'fee']) {
    const { deps: { db } } = makeTestDeps();
    seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 36000 });
    securities(db);
    anchor(db, 'inv', [['sa', 3, 30000], ['cash', 6000, 6000]]);
    price(db, 'SYNA', '2026-03-10', 10000);
    txn(db, 'cash-row', 'inv', 'sa', '2026-03-13', -0.75, -600, 800, 'deposit', type);
    const est = loadAccountEstimate(db, 'inv')!;
    assert.equal(est.valueOn('2026-03-12').bySecurity.get('sa'), 30000);
    assert.equal(est.valueOn('2026-03-12').cashCents, 5400);
    assert.equal(est.valueOn('2026-03-13').totalCents, 36000);
  }
});

test('position-changing transfers move shares on the backward walk', () => {
  for (const [quantity, before] of [[2, 10000], [-2, 50000]] as const) {
    const { deps: { db } } = makeTestDeps();
    seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 35000 });
    securities(db);
    anchor(db, 'inv', [['sa', 3, 30000], ['cash', 5000, 5000]]);
    price(db, 'SYNA', '2026-03-10', 10000);
    txn(db, 'transfer', 'inv', 'sa', '2026-03-13', quantity, 0, null, 'transfer', 'transfer');
    const est = loadAccountEstimate(db, 'inv')!;
    assert.equal(est.valueOn('2026-03-12').bySecurity.get('sa'), before);
    assert.equal(est.valueOn('2026-03-13').bySecurity.get('sa'), 30000);
    assert.equal(est.valueOn('2026-03-12').cashCents, 5000);
  }
});

test('cash rows do not distort Plaid-only split factors', () => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'inv', type: 'investment' });
  securities(db);
  anchor(db, 'inv', [['sb', 20, 200000], ['cash', 6300, 6300]]);
  price(db, 'SYNB', '2026-03-01', 20000);
  price(db, 'SYNB', '2026-03-15', 10000);
  txn(db, 'buy', 'inv', 'sb', '2026-03-02', 10, 200000, 20000, 'contribution');
  txn(db, 'split', 'inv', 'sb', '2026-03-05', 10, 0, null, 'stock split');
  txn(db, 'cash', 'inv', 'sb', '2026-03-10', -0.5, -300, 600, 'deposit', 'cash');
  const est = loadAccountEstimate(db, 'inv')!;
  assert.deepEqual(['2026-03-04', '2026-03-06', '2026-03-12'].map((d) => est.valueOn(d).totalCents), [206000, 206000, 206300]);
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
  price(db, 'SYNB', '2026-03-10', 10000);
  price(db, 'SYNB', '2026-03-12', 8000);
  price(db, 'SYNB', '2026-03-15', 10000);
  db.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES ('inv', '2026-03-15', 115000), ('inv2', '2026-03-15', 50000)").run();
  const pts = (ids: string[]) => getNetWorth(db, 'all', '2026-03-15', { type: 'investment', accountIds: ids }).points.map((p) => [p.date, p.netWorthCents]);
  // inv alone: as in buyAndDeposit
  assert.deepEqual(pts(['inv']), [
    ['2026-03-10', 102600], ['2026-03-11', 102600], ['2026-03-12', 105000], ['2026-03-13', 110000], ['2026-03-14', 113000], ['2026-03-15', 115000],
  ]);
  // inv2 alone: cached close 8000 → 40000. 03-15: snapshot 50000
  assert.deepEqual(pts(['inv2']), [['2026-03-12', 40000], ['2026-03-13', 40000], ['2026-03-14', 40000], ['2026-03-15', 50000]]);
  // both, 03-10: inv 102600 + inv2 fully undone (4 sh × close 10000 + cash 8000 = 48000) = 150600
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

test('a sold-out unpriced position is excluded before its sale; proceeds still enter cash', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 5000 });
  securities(db);
  anchor(db, 'inv', [['cash', 5000, 5000]]);
  txn(db, 's1', 'inv', 'sc', '2026-03-12', -1, -10000, 10000, 'sell');
  const est = loadAccountEstimate(db, 'inv')!;
  assert.equal(est.valueOn('2026-03-11').totalCents, -5000);
  assert.deepEqual([...est.valueOn('2026-03-11').excluded], ['sc']);
  assert.equal(est.valueOn('2026-03-12').totalCents, 5000);
  assert.equal(est.valueOn('2026-03-12').excluded.size, 0);
});

test('a split only Plaid records is undone with its shares', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 200000 });
  securities(db);
  anchor(db, 'inv', [['sb', 20, 200000]]);
  txn(db, 'b1', 'inv', 'sb', '2026-03-11', 10, 200000, 20000);
  txn(db, 's1', 'inv', 'sb', '2026-03-13', 10, 0, null, 'stock split');
  price(db, 'SYNB', '2026-03-10', 20000);
  price(db, 'SYNB', '2026-03-15', 10000);
  // 20 − 10 (split undone) = 10 sh × cached close 20000 = 200000
  assert.equal(loadAccountEstimate(db, 'inv')!.valueOn('2026-03-12').totalCents, 200000);
});

test('an unsupported ticker is excluded even when an unrelated stock has cached prices', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 20000 });
  securities(db);
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('sx', 'Synthetic Coin', 'SYNX', 'cryptocurrency', 0, 'seed')").run();
  anchor(db, 'inv', [['sx', 2, 20000]]);
  txn(db, 'b1', 'inv', 'sx', '2026-03-12', 1, 8000, 8000);
  price(db, 'SYNX', '2026-03-11', 99999);
  const value = loadAccountEstimate(db, 'inv')!.valueOn('2026-03-12');
  assert.equal(value.totalCents, 0);
  assert.deepEqual([...value.excluded], ['sx']);
});

test('an investment account with a balance but no holdings stays flat before its first snapshot', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 50000 });
  seedAccount(db, { id: 'chk', balanceCents: 1000 });
  db.prepare("INSERT INTO holding_syncs (account_id, date) VALUES ('inv', '2026-03-15')").run();
  db.prepare("INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES ('chk', '2026-03-13', 1000), ('inv', '2026-03-15', 50000)").run();
  // no holdings at H: no estimate, so inv holds its first snapshot 50000 before S. 03-13, 03-14: 1000 + 50000 = 51000 (estimated: 1000 + 0)
  assert.equal(loadAccountEstimate(db, 'inv'), null);
  assert.deepEqual(getNetWorth(db, 'all', '2026-03-15').points.map((p) => p.netWorthCents), [51000, 51000, 51000]);
});

test('cash-security rows move cash unless they are sweeps', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 250000 });
  securities(db);
  anchor(db, 'inv', [['sa', 10, 100000], ['cash', 150000, 150000]]);
  price(db, 'SYNA', '2026-03-10', 10000);
  txn(db, 'sw', 'inv', 'cash', '2026-03-14', 1000, 1000, 100, 'buy', 'buy');
  txn(db, 'dp', 'inv', 'cash', '2026-03-13', 0, -100000, null, 'deposit', 'cash');
  txn(db, 'ds', 'inv', 'cash', '2026-03-12', 0, -1000, 0, 'distribution', 'cash');
  const est = loadAccountEstimate(db, 'inv')!;
  // H cash 150000. 03-13: sweep (buy) ignored → 150000. 03-12: deposit undone → 50000. 03-11: distribution undone → 49000.
  // (dropping all three: 150000 every day)
  assert.deepEqual(['2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'].map((d) => est.valueOn(d).cashCents), [49000, 50000, 150000, 150000]);
  // 03-11: 10 × 10000 + 49000; the cash security never becomes shares
  assert.equal(est.valueOn('2026-03-11').totalCents, 149000);
  assert.equal(est.valueOn('2026-03-11').bySecurity.has('cash'), false);
});

test('a contribution buys shares without spending held cash', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 100000 });
  securities(db);
  anchor(db, 'inv', [['sa', 10, 100000]]);
  price(db, 'SYNA', '2026-03-10', 10000);
  txn(db, 'c1', 'inv', 'sa', '2026-03-12', 10, 100000, 10000, 'contribution');
  const est = loadAccountEstimate(db, 'inv')!;
  // 03-12: 10 × 10000 = 100000. 03-11: 0 sh, cash stays 0 → 0 (undoing the cash would give a phantom 100000)
  assert.deepEqual(['2026-03-11', '2026-03-12'].map((d) => est.valueOn(d).totalCents), [0, 100000]);
  assert.equal(est.valueOn('2026-03-11').cashCents, 0);
});

test('holding history counts an account that sold the holding before its anchor', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a', type: 'investment', balanceCents: 102000 });
  seedAccount(db, { id: 'b', type: 'investment', balanceCents: 100000 });
  securities(db);
  anchor(db, 'a', [['sa', 10, 102000]]);
  anchor(db, 'b', [['cash', 100000, 100000]]);
  txn(db, 'ab', 'a', 'sa', '2026-03-10', 2, 19600, 9800);
  txn(db, 'bs', 'b', 'sa', '2026-03-12', -10, -100000, 10000, 'sell');
  for (const [d, c] of [['2026-03-10', 9800], ['2026-03-12', 10000], ['2026-03-14', 10200]] as const) price(db, 'SYNA', d, c);
  // a: 10 sh every day (its buy on 03-10 is the earliest, never undone in the window): 98000, 98000, 100000, 100000, 102000, H 102000.
  // b: 10 sh before its 03-12 sale: 03-10, 03-11 at 9800 = 98000; then 0 (synced at H without SYNA).
  // 03-10, 03-11: 98000 + 98000 = 196000 (without b: 98000)
  assert.deepEqual(getHoldingHistory(db, 'SYNA', 'all', '2026-03-15')!.points.map((p) => [p.date, p.netWorthCents]), [
    ['2026-03-10', 196000], ['2026-03-11', 196000], ['2026-03-12', 100000], ['2026-03-13', 100000], ['2026-03-14', 102000], ['2026-03-15', 102000],
  ]);
});

test('Plaid-only splits adjust cached closes across forward and reverse splits', () => {
  for (const factor of [2, 0.5]) {
    const { deps: { db } } = makeTestDeps();
    seedAccount(db, { id: 'inv', type: 'investment' });
    securities(db);
    anchor(db, 'inv', [['sb', 10 * factor, 200000]]);
    price(db, 'SYNB', '2026-03-01', 20000);
    price(db, 'SYNB', '2026-03-15', 20000 / factor);
    txn(db, 'b', 'inv', 'sb', '2026-03-01', 10, 200000, 20000);
    txn(db, 's', 'inv', 'sb', '2026-03-05', 10 * factor - 10, 0, null, 'stock split');
    const est = loadAccountEstimate(db, 'inv')!;
    for (const day of ['2026-03-02', '2026-03-05', '2026-03-07', '2026-03-15']) {
      assert.equal(est.valueOn(day).totalCents, 200000, `${factor}: ${day}`);
    }
  }
});

test('Plaid-only split factors convert cached closes for held and sold-out positions', () => {
  for (const sold of [false, true]) {
    const { deps: { db } } = makeTestDeps();
    seedAccount(db, { id: 'inv', type: 'investment' });
    securities(db);
    anchor(db, 'inv', sold ? [['cash', 200000, 200000]] : [['sb', 20, 200000]]);
    price(db, 'SYNB', '2026-03-01', 20000);
    price(db, 'SYNB', '2026-03-15', 10000);
    txn(db, 's', 'inv', 'sb', '2026-03-05', 10, 0, null, 'stock split');
    if (sold) txn(db, 'sell', 'inv', 'sb', '2026-03-10', -20, -200000, 10000, 'sell');
    const est = loadAccountEstimate(db, 'inv')!;
    assert.equal(est.valueOn('2026-03-04').totalCents, 200000);
    assert.equal(est.valueOn('2026-03-07').totalCents, 200000);
  }
});

test('multiple Plaid-only splits use the quantities at each split', () => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'inv', type: 'investment' });
  securities(db);
  anchor(db, 'inv', [['sb', 90, 450000]]);
  price(db, 'SYNB', '2026-03-01', 20000);
  price(db, 'SYNB', '2026-03-15', 5000);
  txn(db, 'buy', 'inv', 'sb', '2026-03-01', 10, 200000, 20000, 'contribution');
  txn(db, 'split1', 'inv', 'sb', '2026-03-05', 10, 0, null, 'stock split');
  txn(db, 'buy2', 'inv', 'sb', '2026-03-07', 10, 100000, 10000, 'contribution');
  txn(db, 'split2', 'inv', 'sb', '2026-03-10', 60, 0, null, 'stock split');
  const est = loadAccountEstimate(db, 'inv')!;
  assert.deepEqual(['2026-03-02', '2026-03-06', '2026-03-08', '2026-03-12'].map((d) => est.valueOn(d).totalCents), [200000, 200000, 300000, 300000]);
});
