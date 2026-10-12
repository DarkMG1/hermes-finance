import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncPrices, tiingoTicker } from '../src/prices.ts';
import { makeTestDeps, seedAccount } from './helpers.ts';
import type { Deps } from '../src/deps.ts';

function seed(deps: Deps): void {
  const { db } = deps;
  seedAccount(db, { id: 'inv', type: 'investment', balanceCents: 0 });
  const sec = db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, ?, ?, 'seed')");
  sec.run('sa', 'Synthetic A Fund', 'SYNA', 'etf', 0);
  sec.run('sb', 'Synthetic B Class', 'syn.b', 'equity', 0);
  sec.run('cash', 'Synthetic Dollar', null, 'cash', 1);
  sec.run('sold', 'Synthetic Sold Corp', 'SYNS', 'equity', 0);
  sec.run('idle', 'Synthetic Idle Corp', 'SYNI', 'equity', 0);
  const h = db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, updated_at) VALUES ('inv', ?, 1, 100, 100, 'seed')");
  h.run('sa'); h.run('sb'); h.run('cash');
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, quantity, amount_cents, updated_at) VALUES ('t1', 'inv', 'sold', '2025-06-01', 'sell', -1, -100, 's')").run();
}

test('tiingo tickers use dashes for share classes', () => {
  assert.equal(tiingoTicker('brk.b'), 'BRK-B');
  assert.equal(tiingoTicker('SYNA'), 'SYNA');
});

test('prices are fetched for held and traded tickers, from 730 days back, then incrementally', async () => {
  const { deps, prices } = makeTestDeps();
  seed(deps);
  prices.series.set('SYNA', [{ date: '2026-03-13', close: 101.5, splitFactor: 1 }, { date: '2026-03-14', close: 102, splitFactor: 2 }]);
  await syncPrices(deps);
  assert.deepEqual(prices.calls.map((c) => c[0]).sort(), ['SYN.B', 'SYNA', 'SYNS']);
  assert.ok(prices.calls.every((c) => c[1] === '2024-03-15' && c[2] === '2026-03-15'));
  assert.deepEqual(deps.db.prepare("SELECT ticker, date, close_cents, split_factor FROM security_prices ORDER BY date").all(), [
    { ticker: 'SYNA', date: '2026-03-13', close_cents: 10150, split_factor: 1 },
    { ticker: 'SYNA', date: '2026-03-14', close_cents: 10200, split_factor: 2 },
  ]);
  prices.calls = [];
  await syncPrices(deps);
  assert.deepEqual(prices.calls.find((c) => c[0] === 'SYNA'), ['SYNA', '2026-03-15', '2026-03-15']);
});

test('errors never throw; not found skips, others stop the run', async () => {
  const { deps, prices } = makeTestDeps();
  seed(deps);
  prices.failWith.set('SYN.B', 'NOT_FOUND');
  prices.failWith.set('SYNA', 'HTTP_500');
  await syncPrices(deps);
  const asked = prices.calls.map((c) => c[0]);
  // tickers run in sorted order: SYN.B (skipped), SYNA (stops the run), SYNS never asked
  assert.deepEqual(asked, ['SYN.B', 'SYNA']);
});

test('no price port: nothing happens', async () => {
  const { deps, prices } = makeTestDeps();
  seed(deps);
  await syncPrices({ ...deps, prices: null });
  assert.deepEqual(prices.calls, []);
});
