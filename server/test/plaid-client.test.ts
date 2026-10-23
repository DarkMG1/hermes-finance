import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaidApi, type LinkTokenGetSessionsResponse } from 'plaid';
import { makeTestDeps } from './helpers.ts';
import { buildLinkTokenRequest, createPlaidClient, mapLinkSessions } from '../src/plaid/client.ts';

const T = '2026-03-15T12:00:00Z';
const exited: LinkTokenGetSessionsResponse = { link_session_id: 'ls-exit', finished_at: T, exit: { error: null, metadata: null } };
const success: LinkTokenGetSessionsResponse = {
  link_session_id: 'ls-ok', finished_at: T,
  results: {
    item_add_results: [{ public_token: 'public-synthetic', accounts: [], institution: { name: 'Synthetic Bank', institution_id: 'ins_0' } }],
    cra_item_add_results: [], cra_update_results: [], bank_income_results: [], payroll_income_results: [], document_income_results: null,
  },
};
const onSuccess: LinkTokenGetSessionsResponse = { link_session_id: 'ls-cb', finished_at: T, on_success: { public_token: 'public-cb', metadata: null } };
const unfinished: LinkTokenGetSessionsResponse = { link_session_id: 'ls-open', started_at: T };
const updateMode: LinkTokenGetSessionsResponse = { link_session_id: 'ls-upd', finished_at: T };
const complete = { status: 'complete', publicToken: 'public-synthetic', institutionName: 'Synthetic Bank' };

test('a success in any session wins regardless of order', () => {
  assert.deepEqual(mapLinkSessions([exited, success]), complete);
  assert.deepEqual(mapLinkSessions([success, exited]), complete);
  assert.deepEqual(mapLinkSessions([exited, onSuccess]), { status: 'complete', publicToken: 'public-cb', institutionName: null });
});

test('unfinished or no session is pending; only exits is exited', () => {
  assert.deepEqual(mapLinkSessions([unfinished]), { status: 'pending' });
  assert.deepEqual(mapLinkSessions([exited, unfinished]), { status: 'pending' });
  assert.deepEqual(mapLinkSessions([]), { status: 'pending' });
  assert.deepEqual(mapLinkSessions([exited]), { status: 'exited' });
});

test('a finished update-mode session with no results completes without a token', () => {
  assert.deepEqual(mapLinkSessions([updateMode]), { status: 'complete', publicToken: null, institutionName: null });
});

test('link tokens ask for Investments: optional on create, consent on update only when asked', () => {
  const create = buildLinkTokenRequest({ mode: 'create' });
  assert.deepEqual(create.products, ['transactions']);
  assert.deepEqual(create.optional_products, ['investments']);
  assert.equal(create.access_token, undefined);
  const update = buildLinkTokenRequest({ mode: 'update', accessToken: 'tok' });
  assert.equal(update.access_token, 'tok');
  assert.equal(update.products, undefined);
  assert.equal(update.additional_consented_products, undefined);
  const consent = buildLinkTokenRequest({ mode: 'update', accessToken: 'tok', addInvestments: true });
  assert.deepEqual(consent.additional_consented_products, ['investments']);
  assert.equal(consent.products, undefined);
});

test('investment pagination returns response account coverage, including empty accounts', async (t) => {
  const { deps } = makeTestDeps();
  const pages = [
    { accounts: [{ account_id: 'pinv' }, { account_id: 'empty' }], investment_transactions: [{ investment_transaction_id: 't1', account_id: 'pinv', date: '2026-03-01', type: 'buy', quantity: 1, amount: 10 }], securities: [], total_investment_transactions: 2 },
    { accounts: [{ account_id: 'empty' }, { account_id: 'pinv' }], investment_transactions: [{ investment_transaction_id: 't2', account_id: 'pinv', date: '2026-03-02', type: 'buy', quantity: 1, amount: 10 }], securities: [], total_investment_transactions: 2 },
  ];
  const offsets: number[] = [];
  t.mock.method(PlaidApi.prototype, 'investmentsTransactionsGet', async (request: { options: { offset: number } }) => {
    offsets.push(request.options.offset);
    return { data: pages.shift()! };
  });
  const result = await createPlaidClient(deps.config).investmentsTransactionsGet('synthetic-token', '2026-03-01', '2026-03-15');
  assert.deepEqual(result.accountIds, ['pinv', 'empty']);
  assert.deepEqual(result.transactions.map((r) => r.id), ['t1', 't2']);
  assert.deepEqual(offsets, [0, 1]);
});

for (const incomplete of ['empty page', 'failed page', 'coverage changed', 'total changed', 'duplicate'])
test(`investment pagination rejects an incomplete fetch: ${incomplete}`, async (t) => {
  const { deps } = makeTestDeps();
  const trade = { investment_transaction_id: 't1', account_id: 'pinv', date: '2026-03-01', type: 'buy', quantity: 1, amount: 10 };
  let calls = 0;
  t.mock.method(PlaidApi.prototype, 'investmentsTransactionsGet', async () => {
    calls += 1;
    if (calls === 2 && incomplete === 'failed page') throw new Error('synthetic failure');
    return { data: {
      accounts: [{ account_id: calls === 2 && incomplete === 'coverage changed' ? 'other' : 'pinv' }],
      investment_transactions: calls === 1 || incomplete === 'duplicate' ? [trade] : [], securities: [],
      total_investment_transactions: calls === 2 && incomplete === 'total changed' ? 1 : 2,
    } };
  });
  await assert.rejects(createPlaidClient(deps.config).investmentsTransactionsGet('synthetic-token', '2026-03-01', '2026-03-15'));
});
