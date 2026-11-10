import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileReadResult } from '@hermes/shared';
import { buildApp } from '../../src/app.ts';
import type { ProfileReadOutput } from '../../src/profile-reader.ts';
import { FakeClaude, end, start, text as textRound, tool } from '../fake-claude.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedItem, seedPerson, seedSplit, seedTxn } from '../helpers.ts';

export const FIXTURE_DIR = 'app-ios/HermesKit/Tests/HermesKitTests/Fixtures';

// Deterministic: fixed ids, the test clock, and random ids normalised before writing.
export async function buildFixtures(): Promise<Record<string, string>> {
  process.env.TZ = 'UTC'; // snapshot dates use the process-local day
  const { deps, plaid, profileReader } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p-item-1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  db.prepare("UPDATE items SET last_synced_at = '2026-03-15T11:00:00.000Z' WHERE id = 'item-1'").run();
  seedItem(deps, { id: 'item-2', plaidItemId: 'p-item-2', institutionName: 'Synthetic Credit Union', accessToken: 'tok2', status: 'login_required' });
  seedAccount(db, { id: 'acct-checking', itemId: 'item-1', plaidAccountId: 'pa-1', type: 'depository', subtype: 'checking', balanceCents: 250000 });
  seedAccount(db, { id: 'acct-card', itemId: 'item-1', plaidAccountId: 'pa-2', type: 'credit', balanceCents: 4200 });
  seedCategory(db, { id: 'cat-food', name: 'Synthetic Food' });
  seedCategory(db, { id: 'cat-pay', name: 'Synthetic Pay', isIncome: true });
  seedPerson(db, { id: 'person-1', name: 'Synthetic Quill', matchText: 'SYNTHETIC QUILL' });
  seedTxn(db, { id: 'txn-1', accountId: 'acct-card', date: '2026-03-14', amountCents: -1250, source: 'plaid', sourceId: 'ps-1', categoryId: 'cat-food', merchantName: 'Synthetic Cafe', bankDescription: 'SYNTHETIC CAFE 001' });
  seedTxn(db, { id: 'txn-2', accountId: 'acct-checking', date: '2026-03-13', amountCents: 300000, source: 'plaid', sourceId: 'ps-2', categoryId: 'cat-pay', payee: 'Synthetic Employer' });
  seedTxn(db, { id: 'txn-3', accountId: 'acct-card', date: '2026-03-12', amountCents: -4000, source: 'manual', payee: 'Synthetic Split', pending: true });
  seedSplit(db, { id: 'line-1', transactionId: 'txn-3', amountCents: -2500, categoryId: 'cat-food', payee: 'Synthetic Lamp' });
  seedSplit(db, { id: 'line-2', transactionId: 'txn-3', amountCents: -1500, categoryId: null, personId: 'person-1' });
  seedTxn(db, { id: 'txn-4', accountId: 'acct-checking', date: '2026-03-11', amountCents: 1000, source: 'plaid', sourceId: 'ps-4', personId: 'person-1',
    bankDescription: 'SYNTHETIC TRANSFER' });
  seedTxn(db, { id: 'txn-5', accountId: 'acct-checking', date: '2026-03-10', amountCents: 500, source: 'plaid', sourceId: 'ps-5',
    plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER', bankDescription: 'ZELLE FROM SYNTHETIC QUILL' });
  seedTxn(db, { id: 'txn-6', accountId: 'manual', date: '2026-03-09', amountCents: -300, categoryId: 'cat-food', payee: 'Synthetic Market',
    paidByPersonId: 'person-1' });
  db.prepare("INSERT INTO iou_links (id, payback_transaction_id, payback_line_id, item_transaction_id, item_line_id, amount_cents, created_at) VALUES ('link-1', 'txn-4', NULL, 'txn-3', 'line-2', 1000, 'seed')").run();
  const snap = db.prepare('INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES (?, ?, ?)');
  snap.run('acct-checking', '2026-03-14', 400000);
  snap.run('acct-card', '2026-03-14', 4000);
  snap.run('acct-checking', '2026-03-15', 250000);
  snap.run('acct-card', '2026-03-15', 4200);
  plaid.linkResults.set('link-create-1', { status: 'complete', publicToken: 'public-x', institutionName: 'Synthetic Bank' });

  const app = buildApp(deps);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: AUTH })).json();
  const post = async (url: string, payload?: object) =>
    (await app.inject({ method: 'POST', url, headers: { ...AUTH, 'idempotency-key': `fixture-${url}` }, ...(payload === undefined ? {} : { payload }) })).json();

  const linkSession = await post('/v1/plaid/link-sessions', { mode: 'create' }) as { sessionId: string };
  const sessionId = linkSession.sessionId;
  const out: Record<string, unknown> = {
    health: await get('/v1/health'),
    home: await get('/v1/home'),
    people: await get('/v1/people'),
    person: await get('/v1/people/person-1'),
    'people-suggestions': await get('/v1/people/suggestions'),
    accounts: await get('/v1/accounts'),
    categories: await get('/v1/categories'),
    'transactions-page': await get('/v1/transactions?limit=2'),
    transaction: await get('/v1/transactions/txn-3'),
    'transaction-iou': await get('/v1/transactions/txn-4'),
    'payback-choices': await get('/v1/transactions/txn-4/payback?personId=person-1'),
    spending: await get('/v1/spending?period=month&date=2026-03'),
    expenses: await get('/v1/expenses?period=month&date=2026-03'),
    reconcile: await get('/v1/reconcile?month=2026-03'),
    'reconcile-months': await get('/v1/reconcile/months'),
    'net-worth': await get('/v1/net-worth?range=1m'),
    banks: await get('/v1/banks'),
    'sync-status': { items: [{ itemId: 'item-1', institutionName: 'Synthetic Bank', result: 'ok', added: 2, modified: 1, removed: 0 }] },
    'link-session': { ...linkSession, sessionId: 'fixture-session' },
    'apple-card-import': await post('/v1/imports/apple-card', {
      csv: 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n03/01/2026,03/02/2026,SYNTHETIC SHOP,Synthetic Shop,Shopping,Purchase,9.99,Synthetic Person',
    }),
    'error-not-found': await get('/v1/transactions/missing'),
  };
  out['link-complete'] = await post(`/v1/plaid/link-sessions/${sessionId}/complete`);
  // itemization goes in after the fixtures above so those stay as they are
  db.prepare("INSERT INTO receipts (transaction_id, jpeg, bytes, created_at, tax_cents, tip_cents, fees_cents, total_cents, read_at, model) VALUES ('txn-1', ?, 3, '2026-03-15T11:00:00.000Z', 50, 0, 0, 1250, '2026-03-15T11:00:00.000Z', 'fixture-model')")
    .run(Buffer.from([0xff, 0xd8, 0xff]));
  const ri = db.prepare('INSERT INTO receipt_items (id, transaction_id, position, name, amount_cents, people) VALUES (?, ?, ?, ?, ?, ?)');
  ri.run('ritem-1', 'txn-1', 0, 'Synthetic Bagel', 700, '["me"]');
  ri.run('ritem-2', 'txn-1', 1, 'Synthetic Coffee', 500, '["me","person-1"]');
  out.itemization = await get('/v1/transactions/txn-1/receipt/items');
  out['item-shares'] = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'test-vectors', 'item-shares.json'), 'utf8'));
  // the inbox goes in last so the fixtures above stay as they are
  const inboxPhoto = Buffer.from([0xff, 0xd8, 0xff]);
  db.prepare(`INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at, read_at, model, merchant, purchase_date, total_cents, tax_cents, tip_cents, fees_cents, items)
    VALUES ('inbox-1', ?, 3, '2026-03-15T10:00:00.000Z', '2026-03-15T10:00:05.000Z', 'fixture-model', 'Synthetic Grocer', '2026-03-15', 640, 40, 0, 0, ?)`)
    .run(inboxPhoto, JSON.stringify([{ name: 'Synthetic Pear', amountCents: 600, people: ['me', 'person-1'] }]));
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'person-1', tagged = 1 WHERE id = 'inbox-1'").run();
  db.prepare(`INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at, read_at, model, merchant, total_cents, linked_transaction_id, linked_at, split_applied)
    VALUES ('inbox-2', NULL, 3, '2026-03-14T10:00:00.000Z', '2026-03-14T10:00:05.000Z', 'fixture-model', 'Synthetic Cafe', 1250, 'txn-1', '2026-03-15T11:30:00.000Z', 1)`).run();
  out.inbox = await get('/v1/receipts/inbox');
  out['inbox-items'] = await get('/v1/receipts/inbox/inbox-1/items');
  out['inbox-linked'] = (out.inbox as { recentlyLinked: unknown[] }).recentlyLinked[0];
  db.prepare("INSERT INTO recurring_streams VALUES ('fx-stream', 'item-1', 'Synthetic TV', 'monthly', 1500, 1700, '2026-03-05', '2026-04-05', 1, 'mature', '2026-03-15T11:00:00.000Z', '[]')").run();
  out.recurring = await get('/v1/recurring');
  // a longer name the owner left out of Synthetic Split's History: listed in names, not in rows
  seedTxn(db, { id: 'txn-7', accountId: 'acct-card', date: '2026-03-08', amountCents: -900, source: 'plaid', sourceId: 'ps-7', categoryId: 'cat-food', merchantName: 'Synthetic TV' });
  seedTxn(db, { id: 'txn-8', accountId: 'acct-card', date: '2026-03-07', amountCents: -600, categoryId: 'cat-food', payee: 'Synthetic Split Extra' });
  db.prepare("INSERT INTO history_exclusions VALUES ('synthetic split', 'synthetic split extra', 1)").run();
  out['payee-history'] = await get('/v1/payee-history?name=Synthetic%20Split');
  out['transaction-recurring'] = await get('/v1/transactions/txn-7');
  seedCategory(db, { id: 'cat-reimb', name: 'Reimbursement', isTransfer: true });
  seedTxn(db, { id: 'txn-9', accountId: 'acct-card', date: '2026-03-04', amountCents: -2000, categoryId: 'cat-reimb', payee: 'Synthetic Airline' });
  seedTxn(db, { id: 'txn-10', accountId: 'acct-checking', date: '2026-03-06', amountCents: 1500, categoryId: 'cat-reimb', payee: 'Synthetic Employer' });
  out.reimbursements = await get('/v1/reimbursements');
  out['reimbursements-cleanup'] = await get('/v1/people/reimbursements-cleanup');
  // investments use their own database so the accounts, home and net worth fixtures stay as they are
  const inv = makeTestDeps().deps;
  seedAccount(inv.db, { id: 'acct-brokerage', type: 'investment', subtype: 'brokerage', balanceCents: 150000 });
  seedAccount(inv.db, { id: 'acct-retirement', type: 'investment', subtype: 'roth', balanceCents: 50000 });
  const sec = inv.db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, ?, ?, '2026-03-15T11:00:00.000Z')");
  sec.run('sec-syna', 'Synthetic A Fund', 'SYNA', 'etf', 0);
  sec.run('sec-cash', 'Synthetic Dollar', null, 'cash', 1);
  const hold = inv.db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, '2026-03-15T11:00:00.000Z')");
  hold.run('acct-brokerage', 'sec-syna', 2, 50000, 100000, 90000);
  hold.run('acct-retirement', 'sec-syna', 1, 50000, 50000, 40000);
  hold.run('acct-brokerage', 'sec-cash', 50000, 100, 50000, null);
  const hs = inv.db.prepare('INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES (?, ?, ?, ?, ?)');
  hs.run('acct-brokerage', 'sec-syna', '2026-03-14', 2, 95000);
  hs.run('acct-retirement', 'sec-syna', '2026-03-14', 1, 48000);
  hs.run('acct-brokerage', 'sec-syna', '2026-03-15', 2, 100000);
  hs.run('acct-retirement', 'sec-syna', '2026-03-15', 1, 50000);
  hs.run('acct-brokerage', 'sec-cash', '2026-03-15', 50000, 50000);
  const synced = inv.db.prepare('INSERT INTO holding_syncs (account_id, date) VALUES (?, ?)');
  for (const day of ['2026-03-14', '2026-03-15']) for (const account of ['acct-brokerage', 'acct-retirement']) synced.run(account, day);
  const bs = inv.db.prepare('INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES (?, ?, ?)');
  bs.run('acct-brokerage', '2026-03-14', 140000);
  bs.run('acct-retirement', '2026-03-14', 50000);
  bs.run('acct-brokerage', '2026-03-15', 150000);
  bs.run('acct-retirement', '2026-03-15', 50000);
  const invApp = buildApp(inv);
  const invGet = async (url: string) => (await invApp.inject({ method: 'GET', url, headers: AUTH })).json();
  out.investments = await invGet('/v1/investments');
  out['investments-history'] = await invGet('/v1/investments/history?range=1m');
  out['holding-history'] = await invGet('/v1/investments/holding-history?key=SYNA&range=1m');
  // estimate inputs go in after the fixtures above so those stay as they are
  inv.db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, price_cents, updated_at) VALUES ('it-1', 'acct-brokerage', 'sec-syna', '2026-03-12', 'buy', 'buy', 1, 48000, 48000, 's')").run();
  const px = inv.db.prepare('INSERT INTO security_prices (ticker, date, close_cents) VALUES (?, ?, ?)');
  px.run('SYNA', '2026-03-11', 47000);
  px.run('SYNA', '2026-03-12', 48000);
  px.run('SYNA', '2026-03-13', 47500);
  out['holding-history-estimated'] = await invGet('/v1/investments/holding-history?key=SYNA&range=1m');
  sec.run('sec-option', 'Synthetic Option', 'SYNX', 'derivative', 0);
  inv.db.prepare(`INSERT INTO investment_transactions VALUES
    ('option-buy', 'acct-brokerage', 'sec-option', '2026-03-11', 'buy', 'buy', 1, 6000, 6000, 's'),
    ('option-sell', 'acct-brokerage', 'sec-option', '2026-03-13', 'sell', 'sell', -1, -4000, 4000, 's')`).run();
  out['investments-history-excluded'] = await invGet('/v1/investments/history?range=1m');
  // the chat goes in last so the fixtures above stay as they are
  deps.claude = new FakeClaude([[start(), ...tool(0, 'tu1', 'spending', { period: 'month', date: '2026-03' }), ...end('tool_use')],
    [start(), ...textRound(0, 'You spent ', '$12.50 on Synthetic Food.'), ...end('end_turn')]]);
  const chatId = (await post('/v1/chats') as { id: string }).id;
  await app.inject({ method: 'POST', url: `/v1/chats/${chatId}/messages`, headers: AUTH, payload: { clientId: 'fixture-send', text: 'How much did I spend on food?' } });
  const detail = await get(`/v1/chats/${chatId}`) as { messages: { id: string }[] };
  const chatIds = (v: unknown) => JSON.parse([chatId, ...detail.messages.map((m) => m.id)]
    .reduce((t, id, i) => t.replaceAll(id, i ? `msg-${i}` : 'chat-1'), JSON.stringify(v))) as unknown;
  out['chat-list'] = chatIds(await get('/v1/chats'));
  out['chat-detail'] = chatIds(detail);
  db.prepare("INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars) VALUES (?, '2026-03', 'main', 'chat', 'fixture-model', 1000, 50, 0, 0, 420000)").run(deps.now().toISOString());
  out['ai-usage'] = await get('/v1/ai/usage');
  // the financial profile goes in last so the fixtures above stay as they are
  db.prepare(`INSERT INTO jobs (id, employer, title, status, start_date, base_cents, bonus_target_pct, created_at, updated_at)
    VALUES ('job-1', 'SYNTHETIC EMPLOYER', 'Synthetic Engineer', 'current', '2025-06-01', 12000000, 10, 'seed', 'seed')`).run();
  db.prepare("INSERT INTO equity_grants VALUES ('grant-1', 'job-1', 'rsu', 400, NULL, NULL, '2025-06-01', 12, 48, 3)").run();
  const stubRow = db.prepare('INSERT INTO pay_stubs VALUES (?, ?, ?, ?, ?, 420000, 50000, 15000, 26040, 6090, 21000, 1870, ?, ?, 2520000, \'seed\', \'CA\')');
  stubRow.run('stub-1', 'job-1', '2026-03-13', '2026-02-28', '2026-03-13', 0, 300000);
  stubRow.run('stub-2', null, '2026-02-27', null, null, 2500, 302500);
  db.prepare("INSERT INTO pay_stub_deposits VALUES ('stub-1', 'txn-2')").run();
  db.prepare("INSERT INTO tax_forms VALUES ('form-1', 'job-1', 2025, 'w2', 'SYNTHETIC EMPLOYER', 6500000, 800000, 'CA', 270000, 7000000, 7000000, 'seed')").run();
  db.prepare(`INSERT INTO tax_returns VALUES ('return-1', 2025, 'federal', 'single', 6500000, 6520000, 6520000, 'standard', 1500000, 5020000, 650000, 0,
    800000, 150000, 20000, 0, 'seed', 'seed', 0, 5000, 15000)`).run();
  await app.inject({ method: 'PUT', url: '/v1/profile', headers: { ...AUTH, 'idempotency-key': 'fixture-profile' },
    payload: { state: 'CA', filingStatus: 'single', birthYear: 2000, dependents: 0, retirementPct: 6, retirementKind: 'pre_tax', hsa: true } });
  out.profile = await get('/v1/profile');
  await app.inject({ method: 'PUT', url: '/v1/jobs/job-1/w4', headers: { ...AUTH, 'idempotency-key': 'fixture-w4' },
    payload: { signedOn: '2026-01-05', filingStatus: 'single', multipleJobs: false, dependentsCents: 0, extraWithholdingCents: 2500, exempt: false } });
  await app.inject({ method: 'PUT', url: '/v1/jobs/job-1/state-w4/CA', headers: { ...AUTH, 'idempotency-key': 'fixture-de4' },
    payload: { signedOn: '2026-01-05', filingStatus: 'single', allowances: 1, additionalAllowances: 0, exempt: false } });
  out.job = await get('/v1/jobs/job-1');
  out['tax-years'] = await get('/v1/tax-years');
  out['transaction-pay-stub'] = await get('/v1/transactions/txn-2');
  out['pay-stubs-unassigned'] = await get('/v1/pay-stubs/unassigned');
  out['pay-stub-matches'] = await get('/v1/pay-stubs/stub-1/matches');
  const page = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
  for (const [kind, [draft, uncertain]] of Object.entries({
    tax_return: [{ year: 2025, jurisdiction: 'federal', filingStatus: 'single', totalIncomeCents: 6520000, totalTaxCents: 650000, refundCents: 150000 }, ['agiCents']],
    tax_form: [{ year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 6500000, federalWithheldCents: 800000, state: 'CA' }, ['state']],
    pay_stub: [{ employer: 'SYNTHETIC EMPLOYER', payDate: '2026-03-13', grossCents: 420000, federalCents: 50000, netCents: 370000 }, ['grossCents']],
    state_w4: [{ employer: 'SYNTHETIC EMPLOYER', state: 'CA', filingStatus: 'single', allowances: 1, extraWithholdingCents: 1000 }, ['allowances']],
    w4: [{ employer: 'SYNTHETIC EMPLOYER', signedOn: '2026-01-05', filingStatus: 'single', multipleJobs: true, extraWithholdingCents: 2500, exempt: false }, ['multipleJobs']],
    offer: [{ employer: 'SYNTHETIC EMPLOYER', title: 'Synthetic Engineer', baseCents: 12000000, grants: [{ kind: 'rsu', shares: 400, grantDate: '2026-06-01', cliffMonths: 12, vestMonths: 48, vestEveryMonths: 3 }] }, ['baseCents']],
  } as const)) {
    // a PDF of two pay stubs
    const stubs = kind === 'pay_stub' && { stubs: [{ draft, uncertain, saved: false }, { draft: { ...draft, payDate: '2026-03-27', grossCents: 410000, netCents: 360000 }, uncertain: [], saved: false }] };
    profileReader.next = ProfileReadResult.parse({ kind, draft, uncertain, ...stubs }) as ProfileReadOutput;
    out[`profile-read-${kind.replace('_', '-')}`] = await post('/v1/profile/read', { kind, pages: [page] });
  }
  // an answer that read the profile, read back without the profile unlocked
  deps.claude = new FakeClaude([[start(), ...tool(0, 'tu1', 'profile', {}), ...end('tool_use')], [start(), ...textRound(0, 'You file as single.'), ...end('end_turn')]]);
  const locked = (await app.inject({ method: 'POST', url: '/v1/chats', headers: { ...AUTH, 'idempotency-key': 'fixture-profile-chat' } })).json().id as string;
  await app.inject({ method: 'POST', url: `/v1/chats/${locked}/messages`, headers: AUTH, payload: { clientId: 'fixture-profile', text: 'How do I file?', profileUnlocked: true } });
  const lockedDetail = await get(`/v1/chats/${locked}`) as { messages: { id: string }[] };
  out['chat-detail-profile-locked'] = JSON.parse([locked, ...lockedDetail.messages.map((m) => m.id)]
    .reduce((t, id, i) => t.replaceAll(id, i ? `msg-${i}` : 'chat-2'), JSON.stringify(lockedDetail))) as unknown;
  // the pay stub read's document kept with stub-1, listed and read again (stub-1 shares the first stub's pay date)
  const docId = (out['profile-read-pay-stub'] as { documentId: string }).documentId;
  await app.inject({ method: 'PATCH', url: '/v1/pay-stubs/stub-1', headers: { ...AUTH, 'idempotency-key': 'fixture-doc-link' }, payload: { documentId: docId } });
  out.documents = await get('/v1/documents?recordType=pay_stub&recordId=stub-1');
  profileReader.next = { ...ProfileReadResult.parse(out['profile-read-pay-stub']), model: 'fake-model' } as ProfileReadOutput;
  out['document-reread'] = await post(`/v1/documents/${docId}/read`);
  // tax projection: its own database, a synthetic state-figures file (XA flat, XB progressive), and a loss to harvest
  const tax = makeTestDeps().deps;
  const stateFile = join(tmpdir(), `hermes-fixture-state-${process.pid}.json`);
  writeFileSync(stateFile, JSON.stringify({ 2026: {
    XA: { model: 'flat', rate: 0.04, exemptionCents: 500000, dependentExemptionCents: 100000, source: 'synthetic XA' },
    XB: { model: 'progressive_ratio', brackets: [[2000000, 0.02], [null, 0.05]], standardDeductionCents: 500000, exemptionCreditCents: 0, movingExpenses: true, supplementalRate: 0.05, source: 'synthetic XB' },
  } }));
  tax.config.stateTaxFile = stateFile;
  const taxApp = buildApp(tax);
  let taxN = 0;
  const taxSend = async (method: 'POST' | 'PUT', url: string, payload: object) => {
    const r = await taxApp.inject({ method, url, headers: { ...AUTH, 'idempotency-key': `fixture-tax-${(taxN += 1)}` }, payload });
    if (r.statusCode >= 300) throw new Error(`tax fixture ${method} ${url}: ${r.body}`);
    return r;
  };
  const taxGet = async (url: string) => (await taxApp.inject({ method: 'GET', url, headers: AUTH })).json();
  await taxSend('PUT', '/v1/profile', { state: 'XA', filingStatus: 'single', claimedAsDependent: false, fullTimeStudent: false });
  const job = (await taxSend('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current', startDate: '2025-01-01' })).json().id as string;
  for (const payDate of ['2026-01-09', '2026-01-23', '2026-02-06', '2026-02-20', '2026-03-06']) {
    await taxSend('POST', '/v1/pay-stubs', { jobId: job, payDate, grossCents: 200000, federalCents: 20000, stateCents: 8000, netCents: 172000, state: 'XA' });
  }
  seedAccount(tax.db, { id: 'acct-tax-brokerage', type: 'investment', subtype: 'brokerage', balanceCents: 80000 });
  tax.db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('sec-taxa', 'Synthetic Tax Fund', 'SYNT', 'etf', 0, 'x')").run();
  tax.db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES ('buy-1', 'acct-tax-brokerage', 'sec-taxa', '2025-10-01', 'buy', 'buy', 10, 100000, 'x')").run();
  tax.db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES ('acct-tax-brokerage', 'sec-taxa', 10, 8000, 80000, 100000, 'x')").run();
  // 6 shares held before the history, 4 sold, 2 held with an entered lot: the other 4 stay unresolved until their lot is entered
  tax.db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('sec-taxb', 'Synthetic Old Fund', 'SYNO', 'etf', 0, 'x')").run();
  tax.db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES ('acct-tax-brokerage', 'sec-taxb', 2, 10000, 20000, 20000, 'x')").run();
  tax.db.prepare("INSERT INTO lot_entries (id, account_id, security_id, acquired_on, quantity, cost_cents) VALUES ('entry-1', 'acct-tax-brokerage', 'sec-taxb', '2020-05-01', 2, 20000)").run();
  tax.db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES ('sell-1', 'acct-tax-brokerage', 'sec-taxb', '2025-11-03', 'sell', 'sell', -4, -40000, 'x')").run();
  await taxSend('PUT', '/v1/tax/inputs/2026', { studentLoanInterestCents: 50000, k401Cents: 200000 });
  await taxSend('PUT', '/v1/tax/scenario/2027', { bonusCents: 1000000, moveTo: 'XB', moveDate: '2027-07-01' });
  await taxSend('POST', '/v1/tax/roth-contributions', { date: '2026-02-01', amountCents: 100000, taxYear: 2026 });
  out['tax-projection'] = await taxGet('/v1/tax/projection?year=2027');
  out['tax-what-if'] = (await taxSend('POST', '/v1/tax/what-if', { year: 2026, change: { sell: [{ accountId: 'acct-tax-brokerage', securityId: 'sec-taxa', quantity: 10 }], extraWithholdingCents: 50000 } })).json();
  out['tax-heads-up'] = await taxGet('/v1/tax/heads-up?unlocked=1');
  out['tax-inputs'] = await taxGet('/v1/tax/inputs/2026');
  out['tax-scenario'] = await taxGet('/v1/tax/scenario/2027');
  out['tax-lots'] = await taxGet('/v1/tax/lots');
  rmSync(stateFile);

  // ids minted at runtime are replaced so the files are stable
  const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const normalise = (s: string) => s.replace(/"accountId": "[0-9a-f-]{36}"/g, '"accountId": "fixture-applecard"').replace(/"itemId": "[0-9a-f-]{36}"/g, '"itemId": "fixture-item"')
    .replace(/"documentId": "[0-9a-f-]{36}"/g, '"documentId": "fixture-document"').replaceAll(docId, 'fixture-document');
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [`${k}.json`, normalise(text(v))]));
}
