import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { TaxHeadsUp, TaxProjection, TaxWhatIf } from '@hermes/shared';
import { AUTH, makeTestDeps, seedAccount } from './helpers.ts';

function setup() {
  const app = buildApp(makeTestDeps().deps);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: AUTH, payload });
  return { get, post };
}

test('projection defaults to the open year', async () => {
  const { get } = setup();
  const p = TaxProjection.parse((await get('/v1/tax/projection')).json());
  assert.equal(p.year, 2025); // the test clock is Mar 15: last year is still open
  assert.equal(TaxProjection.parse((await get('/v1/tax/projection?year=2027')).json()).year, 2027);
  assert.equal((await get('/v1/tax/projection?year=abc')).statusCode, 400);
});

test('what-if validates input', async () => {
  const { post } = setup();
  assert.equal((await post('/v1/tax/what-if', { year: 2026, change: { bogus: 1 } })).statusCode, 400);
  assert.equal((await post('/v1/tax/what-if', { year: 2026 })).statusCode, 400);
  const r = await post('/v1/tax/what-if', { year: 2026, change: { extraWithholdingCents: 10000 } });
  assert.equal(r.statusCode, 200);
  assert.equal(TaxWhatIf.parse(r.json()).blocked, null);
  assert.equal((await post('/v1/tax/what-if', { year: 2101, change: {} })).statusCode, 400);
  const sell = (lotIds?: string[]) => post('/v1/tax/what-if', { year: 2026, change: { sell: [{ accountId: 'brk', securityId: 'sx', quantity: 1, ...(lotIds && { lotIds }) }] } });
  const twice = await sell(['a', 'a']);
  assert.deepEqual([twice.statusCode, twice.json().field], [400, 'change.sell']);
  // nothing held: blocked, nothing changes
  const blocked = TaxWhatIf.parse((await sell()).json());
  assert.deepEqual([blocked.blocked, blocked.deltaCents], ['No current holding to sell', 0]);
});

test('heads-up hides items without unlocked=1 and covers every open year', async () => {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  const send = async (method: 'POST' | 'PUT', url: string, payload: object) => {
    const r = await app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': `${method}${url}${Math.random()}` }, payload });
    assert.ok(r.statusCode < 300, `${url} ${r.body}`);
    return r.json();
  };
  await send('PUT', '/v1/profile', { filingStatus: 'single', claimedAsDependent: false, fullTimeStudent: false });
  const job = await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current', startDate: '2025-01-01' });
  await send('POST', '/v1/pay-stubs', { jobId: job.id, payDate: '2026-03-06', grossCents: 200000, federalCents: 20000, netCents: 180000 });
  // over the Roth limit for 2025 (the first open year) and over the 401(k) limit for 2027
  deps.db.prepare("INSERT INTO roth_contributions (id, date, amount_cents, tax_year) VALUES ('r0', '2025-02-01', 99999999, 2025)").run();
  await send('PUT', '/v1/tax/scenario/2027', { k401Cents: 99999999 });
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const locked = TaxHeadsUp.parse(await get('/v1/tax/heads-up'));
  assert.equal('items' in locked, false);
  const open = TaxHeadsUp.parse(await get('/v1/tax/heads-up?unlocked=1'));
  assert.equal(open.count, locked.count);
  assert.equal(open.items!.length, open.count);
  assert.ok(open.items!.some((a) => a.title === 'Roth IRA contributions over the 2025 limit') && open.items!.some((a) => a.title === '401(k) over the 2027 limit'));
  assert.deepEqual(TaxHeadsUp.parse(await get('/v1/tax/heads-up?unlocked=0')), locked);
  // a loss to harvest: the locked count skips the sale what-ifs, the items run them
  seedAccount(deps.db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  deps.db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('sx', 'Synthetic', 'SYNA', 'etf', 0, 'x')").run();
  deps.db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES ('b1', 'brk', 'sx', '2025-06-01', 'buy', 'buy', 100, 5000000, 'x')").run();
  deps.db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES ('brk', 'sx', 100, 10000, 1000000, 5000000, 'x')").run();
  const withHarvest = TaxHeadsUp.parse(await get('/v1/tax/heads-up?unlocked=1'));
  assert.ok(withHarvest.items!.some((a) => a.kind === 'harvest_loss'));
  assert.equal(TaxHeadsUp.parse(await get('/v1/tax/heads-up')).count, withHarvest.count - withHarvest.items!.filter((a) => a.kind === 'harvest_loss').length);
});
