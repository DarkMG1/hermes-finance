import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakePlaid, txn } from './fake-plaid.ts';
import { PlaidError } from '../src/plaid/port.ts';

test('fake serves queued pages per cursor and can fail once', async () => {
  const plaid = new FakePlaid();
  plaid.queueSync([{ added: [txn({ transactionId: 'p1' })], modified: [], removed: [], nextCursor: 'c1', hasMore: false }]);
  const page = await plaid.transactionsSync('tok', null);
  assert.equal(page.added[0]?.transactionId, 'p1');
  plaid.failNextSync('ITEM_LOGIN_REQUIRED');
  await assert.rejects(plaid.transactionsSync('tok', 'c1'), (e) => e instanceof PlaidError && e.code === 'ITEM_LOGIN_REQUIRED');
});
