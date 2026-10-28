import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedItem, seedPerson, seedSplit, seedTxn } from '../helpers.ts';

export const FIXTURE_DIR = 'app-ios/HermesKit/Tests/HermesKitTests/Fixtures';

// Deterministic: fixed ids, the test clock, and random ids normalised before writing.
export async function buildFixtures(): Promise<Record<string, string>> {
  process.env.TZ = 'UTC'; // snapshot dates use the process-local day
  const { deps, plaid } = makeTestDeps();
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
    .run(inboxPhoto, JSON.stringify([{ name: 'Synthetic Pear', amountCents: 600, people: ['me'] }]));
  db.prepare("UPDATE inbox_receipts SET for_person_id = 'person-1' WHERE id = 'inbox-1'").run();
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
  // ids minted at runtime are replaced so the files are stable
  const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const normalise = (s: string) => s.replace(/"accountId": "[0-9a-f-]{36}"/g, '"accountId": "fixture-applecard"').replace(/"itemId": "[0-9a-f-]{36}"/g, '"itemId": "fixture-item"');
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [`${k}.json`, normalise(text(v))]));
}
