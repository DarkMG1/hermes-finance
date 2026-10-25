import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncItem } from '../src/sync/run.ts';
import { getNetWorth, localDay } from '../src/networth.ts';
import { getInvestments, getHoldingHistory } from '../src/investments.ts';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedItem } from './helpers.ts';
import type { FakePlaid } from './fake-plaid.ts';
import type { Deps } from '../src/deps.ts';

const BROKERAGE = { accountId: 'pinv', name: 'Synthetic Brokerage', mask: '0002', type: 'investment', subtype: 'brokerage', currentBalance: 300, availableBalance: null };
const SECURITIES = [
  { securityId: 'sa', name: 'Synthetic A Fund', ticker: 'SYNA', type: 'etf', isCash: false, closePrice: 100 },
  { securityId: 'sb', name: 'Synthetic B Corp', ticker: 'SYNB', type: 'equity', isCash: false, closePrice: 50 },
];

function setup(): { deps: Deps; plaid: FakePlaid } {
  const t = makeTestDeps();
  seedItem(t.deps, { id: 'i1', plaidItemId: 'p1', institutionName: 'Synthetic Brokerage', accessToken: 'tok' });
  t.plaid.accounts = [BROKERAGE];
  t.plaid.holdings = {
    securities: SECURITIES,
    holdings: [
      { accountId: 'pinv', securityId: 'sa', quantity: 2, price: 100, value: 200, costBasis: 150 },
      { accountId: 'pinv', securityId: 'sb', quantity: 2, price: 50, value: 100, costBasis: null },
    ],
  };
  return t;
}

const holdings = (deps: Deps) => deps.db.prepare('SELECT security_id, quantity, price_cents, value_cents, cost_basis_cents FROM holdings ORDER BY security_id').all();
const snapshots = (deps: Deps) => deps.db.prepare('SELECT security_id, date, value_cents FROM holding_snapshots ORDER BY security_id').all();
const status = (deps: Deps) => (deps.db.prepare("SELECT investments_status AS s FROM items WHERE id = 'i1'").get() as { s: string | null }).s;

test('a sync stores securities, holdings and today\'s snapshot', async () => {
  const { deps } = setup();
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.deepEqual(holdings(deps), [
    { security_id: 'sa', quantity: 2, price_cents: 10000, value_cents: 20000, cost_basis_cents: 15000 },
    { security_id: 'sb', quantity: 2, price_cents: 5000, value_cents: 10000, cost_basis_cents: null },
  ]);
  const day = localDay(deps.now());
  assert.deepEqual(snapshots(deps), [
    { security_id: 'sa', date: day, value_cents: 20000 },
    { security_id: 'sb', date: day, value_cents: 10000 },
  ]);
  assert.deepEqual(deps.db.prepare('SELECT id, ticker, is_cash FROM securities ORDER BY id').all(), [
    { id: 'sa', ticker: 'SYNA', is_cash: 0 }, { id: 'sb', ticker: 'SYNB', is_cash: 0 },
  ]);
  assert.equal(status(deps), 'ok');
});

test('a second sync replaces holdings and today\'s snapshot', async () => {
  const { deps, plaid } = setup();
  await syncItem(deps, 'i1');
  plaid.holdings = { securities: SECURITIES, holdings: [{ accountId: 'pinv', securityId: 'sa', quantity: 3, price: 110, value: 330, costBasis: 250 }] };
  await syncItem(deps, 'i1');
  assert.deepEqual(holdings(deps), [{ security_id: 'sa', quantity: 3, price_cents: 11000, value_cents: 33000, cost_basis_cents: 25000 }]);
  assert.deepEqual(snapshots(deps), [{ security_id: 'sa', date: localDay(deps.now()), value_cents: 33000 }], 'the sold position leaves today\'s snapshot');
});

test('errors map to a status and never fail the bank sync', async () => {
  const cases: [string, string | null][] = [
    ['ADDITIONAL_CONSENT_REQUIRED', 'consent_required'],
    ['ACCESS_NOT_GRANTED', 'consent_required'],
    ['PRODUCTS_NOT_SUPPORTED', 'not_supported'],
    ['NO_INVESTMENT_ACCOUNTS', 'not_supported'],
    ['PRODUCT_NOT_READY', 'ok'],
  ];
  for (const [code, expected] of cases) {
    const { deps, plaid } = setup();
    await syncItem(deps, 'i1');
    plaid.failNextHoldings(code);
    assert.equal((await syncItem(deps, 'i1')).result, 'ok', code);
    assert.equal(status(deps), expected, code);
    assert.equal((holdings(deps) as unknown[]).length, 2, `${code}: previous holdings kept`);
  }
});

test('rows for one account and security combine into one holding and snapshot', async () => {
  const { deps, plaid } = setup();
  plaid.holdings = {
    securities: SECURITIES,
    holdings: [
      { accountId: 'pinv', securityId: 'sa', quantity: 1, price: 100, value: 100, costBasis: 80 },
      { accountId: 'pinv', securityId: 'sa', quantity: 3, price: 101, value: 303, costBasis: 270 },
      { accountId: 'pinv', securityId: 'sb', quantity: 1, price: 50, value: 50, costBasis: 40 },
      { accountId: 'pinv', securityId: 'sb', quantity: 1, price: 50, value: 50, costBasis: null },
    ],
  };
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.deepEqual(holdings(deps), [
    { security_id: 'sa', quantity: 4, price_cents: 10075, value_cents: 40300, cost_basis_cents: 35000 },
    { security_id: 'sb', quantity: 2, price_cents: 5000, value_cents: 10000, cost_basis_cents: null },
  ]);
  const day = localDay(deps.now());
  assert.deepEqual(snapshots(deps), [{ security_id: 'sa', date: day, value_cents: 40300 }, { security_id: 'sb', date: day, value_cents: 10000 }]);
  assert.equal(status(deps), 'ok');
});

test('items without investment accounts never fetch holdings', async () => {
  const { deps, plaid } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.equal(plaid.holdingsCalls, 0);
  assert.equal(status(deps), null);
});

test('holdings for unknown accounts or securities are skipped', async () => {
  const { deps, plaid } = setup();
  plaid.holdings = {
    securities: SECURITIES,
    holdings: [
      { accountId: 'pinv', securityId: 'sa', quantity: 1, price: 100, value: 100, costBasis: 90 },
      { accountId: 'pelsewhere', securityId: 'sa', quantity: 1, price: 100, value: 100, costBasis: 90 },
      { accountId: 'pinv', securityId: 'smissing', quantity: 1, price: 1, value: 1, costBasis: null },
    ],
  };
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.deepEqual((holdings(deps) as { security_id: string }[]).map((h) => h.security_id), ['sa']);
});

function seedHoldings(deps: Deps): void {
  const { db } = deps;
  seedAccount(db, { id: 'b1', type: 'investment', balanceCents: 0 });
  seedAccount(db, { id: 'b2', type: 'investment', balanceCents: 0 });
  seedAccount(db, { id: 'bh', type: 'investment', balanceCents: 0, hidden: true });
  const sec = db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, ?, ?, 'seed')");
  sec.run('sa1', 'Synthetic A Fund', 'syna', 'etf', 0);
  sec.run('sa2', 'Synthetic A Fund (other listing)', 'SYNA', 'etf', 0);
  sec.run('sc', 'Synthetic C Corp', 'SYNC', 'equity', 0);
  sec.run('cash1', 'Synthetic Dollar', null, 'cash', 0);
  sec.run('cash2', 'Synthetic Sweep', 'SWEEP', 'mutual fund', 1);
  sec.run('nt', 'Synthetic Private Note', null, 'fixed income', 0);
  const h = db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  h.run('b1', 'sa1', 2, 10000, 20000, 15000, '2026-03-15T10:00:00.000Z');
  h.run('b2', 'sa2', 1, 10000, 10000, 8000, '2026-03-15T11:00:00.000Z');
  h.run('b1', 'sc', 4, 1000, 4000, null, '2026-03-15T10:00:00.000Z');
  h.run('b1', 'cash1', 500, 100, 500, null, '2026-03-15T10:00:00.000Z');
  h.run('b2', 'cash2', 300, 100, 300, 300, '2026-03-15T11:00:00.000Z');
  h.run('b2', 'nt', 1, 7000, 7000, 6000, '2026-03-15T11:00:00.000Z');
  h.run('bh', 'sc', 100, 1000, 100000, 1, '2026-03-15T12:00:00.000Z');
}

test('holdings combine by ticker across accounts, cash merges, gain needs every cost basis', () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  seedItem(deps, { id: 'ic', plaidItemId: 'pc', institutionName: 'Synthetic Consent', accessToken: 'tok' });
  deps.db.prepare("UPDATE items SET investments_status = 'consent_required' WHERE id = 'ic'").run();
  const inv = getInvestments(deps.db);
  assert.deepEqual(inv.holdings.map((h) => [h.key, h.name, h.quantity, h.priceCents, h.valueCents, h.costBasisCents, h.gainCents]), [
    ['SYNA', 'Synthetic A Fund', 3, 10000, 30000, 23000, 7000],
    ['nt', 'Synthetic Private Note', 1, 7000, 7000, 6000, 1000],
    ['SYNC', 'Synthetic C Corp', 4, 1000, 4000, null, null],
    ['_cash', 'Cash', 800, null, 800, 800, 0],
  ]);
  assert.deepEqual(inv.holdings[0]!.accounts.map((a) => [a.accountId, a.quantity, a.valueCents, a.costBasisCents]), [
    ['b1', 2, 20000, 15000], ['b2', 1, 10000, 8000],
  ]);
  assert.equal(inv.holdings[0]!.ticker, 'syna', 'name and ticker come from the largest member');
  assert.equal(inv.holdings[3]!.ticker, null);
  assert.equal(inv.totalCents, 41800);
  assert.equal(inv.costBasisCents, null, 'SYNC has no cost basis');
  assert.equal(inv.gainCents, null);
  assert.equal(inv.asOf, '2026-03-15T11:00:00.000Z', 'hidden accounts do not count');
  assert.deepEqual(inv.reconnect, [{ itemId: 'ic', institutionName: 'Synthetic Consent' }]);
});

test('a security with ticker CASH stays apart from cash', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'b1', type: 'investment', balanceCents: 0 });
  const sec = deps.db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, ?, ?, 'seed')");
  sec.run('scash', 'Synthetic Cash Corp', 'CASH', 'equity', 0);
  sec.run('cash1', 'Synthetic Dollar', null, 'cash', 1);
  const h = deps.db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'seed')");
  h.run('b1', 'scash', 10, 2000, 20000, null);
  h.run('b1', 'cash1', 500, 100, 500, null);
  assert.deepEqual(getInvestments(deps.db).holdings.map((x) => [x.key, x.name, x.ticker, x.priceCents, x.valueCents, x.costBasisCents, x.gainCents]), [
    ['CASH', 'Synthetic Cash Corp', 'CASH', 2000, 20000, null, null],
    ['_cash', 'Cash', null, null, 500, 500, 0],
  ]);
});

test('cash without cost basis counts as cost', () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  deps.db.prepare("DELETE FROM holdings WHERE security_id = 'sc'").run();
  const inv = getInvestments(deps.db);
  assert.equal(inv.totalCents, 37800);
  assert.equal(inv.costBasisCents, 29800);
  assert.equal(inv.gainCents, 8000);
});

test('no holdings: zero total and no gain', () => {
  const { deps } = makeTestDeps();
  assert.deepEqual(getInvestments(deps.db), { totalCents: 0, costBasisCents: null, gainCents: null, asOf: null, holdings: [], reconnect: [] });
});

const hsync = (deps: Deps, account: string, date: string) =>
  deps.db.prepare('INSERT OR IGNORE INTO holding_syncs (account_id, date) VALUES (?, ?)').run(account, date);
/** A snapshot also marks its account synced that day. */
const hsnap = (deps: Deps, account: string, security: string, date: string, cents: number) => {
  deps.db.prepare('INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES (?, ?, ?, 1, ?)').run(account, security, date, cents);
  hsync(deps, account, date);
};

test('holding history sums accounts and carries forward', () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  hsnap(deps, 'b1', 'sa1', '2026-03-12', 1000);
  hsnap(deps, 'b2', 'sa2', '2026-03-13', 500);
  hsnap(deps, 'b1', 'sa1', '2026-03-14', 1200);
  hsnap(deps, 'bh', 'sa1', '2026-03-13', 99999);
  const h = getHoldingHistory(deps.db, 'SYNA', 'all', '2026-03-15')!;
  assert.deepEqual(h.points, [
    { date: '2026-03-13', netWorthCents: 1500 },
    { date: '2026-03-14', netWorthCents: 1700 },
    { date: '2026-03-15', netWorthCents: 1700 },
  ]);
  assert.equal(h.currentCents, 1700);
  assert.equal(h.changeCents, 200);
  assert.equal(h.estimatedThrough, null);
  assert.equal(getHoldingHistory(deps.db, 'SYNA', '1m', '2026-03-15')!.points.length, 3);
  assert.equal(getHoldingHistory(deps.db, 'NOPE', 'all', '2026-03-15'), null);
});

test('holding history drops a sold position to 0', () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  hsnap(deps, 'b1', 'sc', '2026-03-13', 4000);
  hsnap(deps, 'b1', 'cash1', '2026-03-13', 100);
  // the 03-14 sync of b1 has cash but no SYNC: sold
  hsnap(deps, 'b1', 'cash1', '2026-03-14', 4100);
  const h = getHoldingHistory(deps.db, 'SYNC', 'all', '2026-03-15')!;
  assert.deepEqual(h.points.map((p) => p.netWorthCents), [4000, 0, 0]);
});

test('a sync that empties an account drops its holdings to 0 from that day', async () => {
  const { deps, plaid } = setup();
  deps.now = () => new Date('2026-03-14T16:00:00Z');
  await syncItem(deps, 'i1');
  deps.now = () => new Date('2026-03-15T16:00:00Z');
  plaid.holdings = { securities: SECURITIES, holdings: [] };
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.equal(status(deps), 'ok');
  assert.deepEqual(getHoldingHistory(deps.db, 'SYNA', 'all', '2026-03-16')!.points.map((p) => p.netWorthCents), [20000, 0, 0]);
});

test('one of two accounts holding a ticker emptied: history shows only the other', () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  hsnap(deps, 'b1', 'sa1', '2026-03-13', 1000);
  hsnap(deps, 'b2', 'sa2', '2026-03-13', 500);
  hsync(deps, 'b2', '2026-03-14');
  assert.deepEqual(getHoldingHistory(deps.db, 'SYNA', 'all', '2026-03-15')!.points.map((p) => p.netWorthCents), [1500, 1000, 1000]);
});

test('investments history uses only investment accounts', () => {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'chk', balanceCents: 5000 });
  seedAccount(deps.db, { id: 'inv', type: 'investment', balanceCents: 3000 });
  seedAccount(deps.db, { id: 'loan', type: 'loan', balanceCents: 1000 });
  assert.deepEqual(getNetWorth(deps.db, 'all', '2026-03-15', { type: 'investment' }),
    { points: [], currentCents: 3000, changeCents: 0, estimatedThrough: null }, 'no snapshots: the live investment total');
  const snap = deps.db.prepare('INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES (?, ?, ?)');
  snap.run('chk', '2026-03-13', 5000);
  snap.run('inv', '2026-03-14', 2800);
  snap.run('inv', '2026-03-15', 3000);
  deps.db.prepare("INSERT INTO transactions (id, account_id, source, date, amount_cents, created_at, updated_at) VALUES ('t1', 'chk', 'manual', '2026-03-01', 100, 's', 's')").run();
  const h = getNetWorth(deps.db, 'all', '2026-03-15', { type: 'investment' });
  assert.deepEqual(h.points, [{ date: '2026-03-14', netWorthCents: 2800 }, { date: '2026-03-15', netWorthCents: 3000 }]);
  assert.equal(h.estimatedThrough, null);
});

test('investment routes', async () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  hsnap(deps, 'b1', 'sa1', '2026-03-15', 1000);
  const app = buildApp(deps);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const inv = await get('/v1/investments');
  assert.equal(inv.statusCode, 200);
  assert.equal(inv.headers['cache-control'], 'no-store');
  assert.equal(inv.json().holdings.length, 4);
  assert.equal((await get('/v1/investments/history?range=1m')).statusCode, 200);
  assert.equal((await get('/v1/investments/history?range=2w')).statusCode, 400);
  assert.equal((await get('/v1/investments/holding-history?key=SYNA&range=all')).json().currentCents, 1000);
  assert.equal((await get('/v1/investments/holding-history?key=NOPE&range=all')).statusCode, 404);
  assert.equal((await get('/v1/investments/holding-history?key=SYNA&range=2w')).statusCode, 400);
  assert.equal((await get('/v1/investments/holding-history?range=all')).statusCode, 400);
  assert.equal((await get('/v1/investments/holding-history?key=&range=all')).statusCode, 400);
  assert.equal((await get('/v1/investments/holding-history?key=SYNA&range=all&x=1')).statusCode, 400);
  assert.equal((await get('/v1/investments/holdings/SYNA/history?range=all')).statusCode, 404, 'the old path route is gone');
  deps.db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('sd', 'Synthetic D Class', 'SYN/D', 'equity', 0, 'seed')").run();
  hsnap(deps, 'b1', 'sd', '2026-03-15', 700);
  const slash = await get(`/v1/investments/holding-history?key=${encodeURIComponent('SYN/D')}&range=all`);
  assert.equal(slash.statusCode, 200);
  assert.equal(slash.json().currentCents, 700);
});

test('holding history reaches back through the estimate', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 115000 });
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('sa', 'Synthetic A Fund', 'SYNA', 'etf', 0, 's'), ('cash', 'Synthetic Dollar', NULL, 'cash', 1, 's')").run();
  db.prepare("INSERT INTO holding_syncs (account_id, date) VALUES ('inv', '2026-03-15')").run();
  db.prepare("INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES ('inv', 'sa', '2026-03-15', 10, 110000), ('inv', 'cash', '2026-03-15', 5000, 5000)").run();
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, price_cents, updated_at) VALUES ('b1', 'inv', 'sa', '2026-03-12', 'buy', 'buy', 4, 40000, 10000, 's'), ('d1', 'inv', NULL, '2026-03-10', 'cash', 'deposit', 0, -30000, NULL, 's')").run();
  const p = db.prepare('INSERT INTO security_prices (ticker, date, close_cents) VALUES (?, ?, ?)');
  for (const [d, c] of [['2026-03-09', 9500], ['2026-03-10', 9600], ['2026-03-12', 10000], ['2026-03-13', 10500], ['2026-03-14', 10800]] as const) p.run('SYNA', d, c);
  const h = getHoldingHistory(db, 'SYNA', 'all', '2026-03-15')!;
  assert.deepEqual(h.points.map((x) => x.netWorthCents), [57600, 57600, 100000, 105000, 108000, 110000]);
  assert.equal(h.points[0]!.date, '2026-03-10');
  assert.equal(h.estimatedThrough, '2026-03-14');
  const cash = getHoldingHistory(db, '_cash', 'all', '2026-03-15')!;
  assert.deepEqual(cash.points.map((x) => x.netWorthCents), [45000, 45000, 5000, 5000, 5000, 5000]);
});

test('unpriced holding history omits estimates while priced and cash histories remain available', () => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'inv', type: 'investment' });
  db.prepare(`INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES
    ('fund', 'Synthetic A Fund', 'SYNA', 'etf', 0, 's'),
    ('option', 'Synthetic Option', 'SYNX', 'derivative', 0, 's'),
    ('cash', 'Synthetic Dollar', NULL, 'cash', 1, 's')`).run();
  db.prepare("INSERT INTO holding_syncs VALUES ('inv', '2026-03-15')").run();
  db.prepare(`INSERT INTO holding_snapshots VALUES ('inv', 'fund', '2026-03-15', 2, 20000),
    ('inv', 'option', '2026-03-15', 1, 4000), ('inv', 'cash', '2026-03-15', 5000, 5000)`).run();
  db.prepare("INSERT INTO security_prices (ticker, date, close_cents) VALUES ('SYNA', '2026-03-09', 10000)").run();
  db.prepare("INSERT INTO investment_transactions VALUES ('buy', 'inv', 'option', '2026-03-10', 'buy', 'buy', 1, 7000, 7000, 's')").run();
  const option = getHoldingHistory(db, 'SYNX', 'all', '2026-03-16')!;
  assert.deepEqual(option.points, [{ date: '2026-03-15', netWorthCents: 4000 }, { date: '2026-03-16', netWorthCents: 4000 }]);
  assert.equal(option.changeCents, 0);
  assert.equal(option.estimatedThrough, null);
  assert.deepEqual(getHoldingHistory(db, 'SYNA', 'all', '2026-03-15')!.points.map((p) => p.netWorthCents), Array(6).fill(20000));
  assert.deepEqual(getHoldingHistory(db, '_cash', 'all', '2026-03-15')!.points.map((p) => p.netWorthCents), Array(6).fill(5000));
});

test('account filter', async () => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  assert.deepEqual(getInvestments(deps.db, ['b1']).holdings.map((h) => [h.key, h.valueCents]), [['SYNA', 20000], ['SYNC', 4000], ['_cash', 500]]);
  assert.deepEqual(getInvestments(deps.db, ['bh']).holdings, [], 'a hidden account stays hidden');
  assert.deepEqual(getInvestments(deps.db, ['nope']).holdings, []);
  hsnap(deps, 'b1', 'sa1', '2026-03-15', 1000);
  hsnap(deps, 'b2', 'sa2', '2026-03-15', 500);
  assert.equal(getHoldingHistory(deps.db, 'SYNA', 'all', '2026-03-15', ['b2'])!.currentCents, 500);
  const app = buildApp(deps);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  assert.equal((await get('/v1/investments?accountIds=b1,b2')).json().holdings.length, 4);
  assert.equal((await get('/v1/investments?accountIds=b2')).json().totalCents, 17300);
  assert.equal((await get('/v1/investments/history?range=all&accountIds=b2')).statusCode, 200);
  assert.equal((await get('/v1/investments/holding-history?key=SYNA&range=all&accountIds=b2')).json().currentCents, 500);
  assert.equal((await get('/v1/investments?other=1')).statusCode, 400);
});

test('one holding history materializes only snapshots in its security group', (t) => {
  const { deps } = makeTestDeps();
  seedHoldings(deps);
  hsnap(deps, 'b1', 'sa1', '2026-03-12', 1000);
  hsnap(deps, 'b2', 'sa2', '2026-03-12', 500);
  hsnap(deps, 'b1', 'sc', '2026-03-12', 99999);
  const prepare = deps.db.prepare.bind(deps.db);
  let count = 0;
  t.mock.method(deps.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('FROM holding_snapshots hs')) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args: unknown[]) => {
        const rows = all(...args);
        count += rows.length;
        return rows;
      });
    }
    return statement;
  });
  assert.equal(getHoldingHistory(deps.db, 'SYNA', 'all', '2026-03-15')!.currentCents, 1500);
  assert.equal(count, 2);
});
