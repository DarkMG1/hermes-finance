import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncItem } from '../src/sync/run.ts';
import { makeTestDeps, seedItem } from './helpers.ts';
import type { Deps } from '../src/deps.ts';
import type { FakePlaid } from './fake-plaid.ts';

const BROKERAGE = { accountId: 'pinv', name: 'Synthetic Brokerage', mask: '0002', type: 'investment', subtype: 'brokerage', currentBalance: 300, availableBalance: null };
const SEC = { securityId: 'sa', name: 'Synthetic A Fund', ticker: 'SYNA', type: 'etf', isCash: false, closePrice: 100 };
const SOLD = { securityId: 'sold', name: 'Synthetic Sold Corp', ticker: 'SYNS', type: 'equity', isCash: false, closePrice: 10 };

function setup(): { deps: Deps; plaid: FakePlaid } {
  const t = makeTestDeps();
  seedItem(t.deps, { id: 'i1', plaidItemId: 'p1', institutionName: 'Synthetic Brokerage', accessToken: 'tok' });
  t.plaid.accounts = [BROKERAGE];
  t.plaid.holdings = { securities: [SEC], holdings: [{ accountId: 'pinv', securityId: 'sa', quantity: 3, price: 100, value: 300, costBasis: 250 }] };
  t.plaid.investmentTxns = {
    securities: [SEC, SOLD],
    transactions: [
      { id: 'it1', accountId: 'pinv', securityId: 'sa', date: '2026-03-01', type: 'buy', subtype: 'buy', quantity: 3, amount: 250, price: 83.33 },
      { id: 'it2', accountId: 'pinv', securityId: 'sold', date: '2026-02-01', type: 'sell', subtype: 'sell', quantity: -5, amount: -50, price: 10 },
      { id: 'it3', accountId: 'elsewhere', securityId: 'sa', date: '2026-02-02', type: 'buy', subtype: 'buy', quantity: 1, amount: 100, price: 100 },
    ],
  };
  return t;
}

const rows = (deps: Deps) => deps.db.prepare('SELECT id, security_id, date, quantity, amount_cents, price_cents FROM investment_transactions ORDER BY id').all();

test('the first fetch asks for 730 days, later ones for 30, and rows upsert', async () => {
  const { deps, plaid } = setup();
  await syncItem(deps, 'i1');
  assert.deepEqual(plaid.investmentTxnCalls, [['2024-03-15', '2026-03-15']]);
  assert.deepEqual(rows(deps), [
    { id: 'it1', security_id: 'sa', date: '2026-03-01', quantity: 3, amount_cents: 25000, price_cents: 8333 },
    { id: 'it2', security_id: 'sold', date: '2026-02-01', quantity: -5, amount_cents: -5000, price_cents: 1000 },
  ]);
  assert.equal((deps.db.prepare("SELECT ticker FROM securities WHERE id = 'sold'").get() as { ticker: string }).ticker, 'SYNS');
  plaid.investmentTxns.transactions[0] = { ...plaid.investmentTxns.transactions[0]!, quantity: 4, amount: 330 };
  await syncItem(deps, 'i1');
  assert.deepEqual(plaid.investmentTxnCalls[1], ['2026-02-13', '2026-03-15']);
  assert.equal((rows(deps) as { quantity: number }[])[0]!.quantity, 4);
  assert.equal((rows(deps) as unknown[]).length, 2);
});

test('a transactions failure keeps the sync and the holdings', async () => {
  const { deps, plaid } = setup();
  plaid.failNextInvestmentTxns('PRODUCT_NOT_READY');
  assert.equal((await syncItem(deps, 'i1')).result, 'ok');
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM holdings').get() as { n: number }).n, 1);
  assert.deepEqual(rows(deps), []);
});

test('no transactions fetch without a successful holdings fetch', async () => {
  const { deps, plaid } = setup();
  plaid.failNextHoldings('ADDITIONAL_CONSENT_REQUIRED');
  await syncItem(deps, 'i1');
  assert.deepEqual(plaid.investmentTxnCalls, []);
});
