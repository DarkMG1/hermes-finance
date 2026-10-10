import { buildApp } from '../../src/app.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedItem, seedPerson, seedSplit, seedTxn } from '../helpers.ts';

export const FIXTURE_DIR = 'app-ios/HermesKit/Tests/HermesKitTests/Fixtures';

// Deterministic: fixed ids, the test clock, and random ids normalised before writing.
export async function buildFixtures(): Promise<Record<string, string>> {
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
  seedSplit(db, { id: 'line-1', transactionId: 'txn-3', amountCents: -2500, categoryId: 'cat-food' });
  seedSplit(db, { id: 'line-2', transactionId: 'txn-3', amountCents: -1500, categoryId: null, personId: 'person-1' });
  seedTxn(db, { id: 'txn-4', accountId: 'acct-checking', date: '2026-03-11', amountCents: 1000, source: 'plaid', sourceId: 'ps-4', personId: 'person-1',
    bankDescription: 'SYNTHETIC TRANSFER' });
  seedTxn(db, { id: 'txn-5', accountId: 'acct-checking', date: '2026-03-10', amountCents: 500, source: 'plaid', sourceId: 'ps-5',
    plaidCategory: 'TRANSFER_IN_ACCOUNT_TRANSFER', bankDescription: 'ZELLE FROM SYNTHETIC QUILL' });
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
    banks: await get('/v1/banks'),
    'sync-status': { items: [{ itemId: 'item-1', institutionName: 'Synthetic Bank', result: 'ok', added: 2, modified: 1, removed: 0 }] },
    'link-session': { ...linkSession, sessionId: 'fixture-session' },
    'apple-card-import': await post('/v1/imports/apple-card', {
      csv: 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n03/01/2026,03/02/2026,SYNTHETIC SHOP,Synthetic Shop,Shopping,Purchase,9.99,Synthetic Person',
    }),
    'error-not-found': await get('/v1/transactions/missing'),
  };
  out['link-complete'] = await post(`/v1/plaid/link-sessions/${sessionId}/complete`);
  // ids minted at runtime are replaced so the files are stable
  const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const normalise = (s: string) => s.replace(/"accountId": "[0-9a-f-]{36}"/g, '"accountId": "fixture-applecard"').replace(/"itemId": "[0-9a-f-]{36}"/g, '"itemId": "fixture-item"');
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [`${k}.json`, normalise(text(v))]));
}
