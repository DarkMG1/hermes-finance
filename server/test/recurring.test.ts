import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshRecurring } from '../src/recurring.ts';
import { makeTestDeps, seedItem } from './helpers.ts';

const stream = (id: string, extra: object = {}) => ({ streamId: id, name: 'Synthetic Stream', frequency: 'MONTHLY', averageAmount: 15.49, lastAmount: 15.49,
  lastDate: '2026-03-01', nextDate: '2026-04-01', isActive: true, status: 'MATURE', ...extra });

test('refresh replaces an item’s streams in positive cents with lowercase enums; an error keeps the old rows', async () => {
  const { deps, plaid } = makeTestDeps();
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  plaid.recurring = [stream('s1'), stream('s2', { frequency: 'SEMI_MONTHLY', status: 'EARLY_DETECTION', isActive: false })];
  await refreshRecurring(deps, 'item-1', 'tok');
  const rows = deps.db.prepare('SELECT stream_id, frequency, average_cents, status, is_active FROM recurring_streams ORDER BY stream_id').all();
  assert.deepEqual(rows, [
    { stream_id: 's1', frequency: 'monthly', average_cents: 1549, status: 'mature', is_active: 1 },
    { stream_id: 's2', frequency: 'semi_monthly', average_cents: 1549, status: 'early_detection', is_active: 0 },
  ]);
  plaid.recurring = [stream('s3')];
  plaid.failNextRecurring('INTERNAL_SERVER_ERROR');
  await refreshRecurring(deps, 'item-1', 'tok');
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM recurring_streams').get() as { n: number }).n, 2);
  await refreshRecurring(deps, 'item-1', 'tok');
  assert.deepEqual((deps.db.prepare('SELECT stream_id FROM recurring_streams').all() as { stream_id: string }[]).map((r) => r.stream_id), ['s3']);
});
