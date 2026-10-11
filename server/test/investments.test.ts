import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncItem } from '../src/sync/run.ts';
import { localDay } from '../src/networth.ts';
import { makeTestDeps, seedItem } from './helpers.ts';
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
