import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addInterval, getRecurring, normalizeName, refreshRecurring } from '../src/recurring.ts';
import { makeTestDeps, seedAccount, seedItem, seedTxn } from './helpers.ts';

const stream = (id: string, extra: object = {}) => ({ streamId: id, name: 'Synthetic Stream', frequency: 'MONTHLY', averageAmount: 15.49, lastAmount: 15.49,
  lastDate: '2026-03-01', nextDate: '2026-04-01', isActive: true, status: 'MATURE', category: null, transactionIds: ['t-a', 't-b'], ...extra });

test('refresh replaces an item’s streams in positive cents with lowercase enums; an error keeps the old rows', async () => {
  const { deps, plaid } = makeTestDeps();
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  plaid.recurring = [stream('s1'), stream('s2', { frequency: 'SEMI_MONTHLY', status: 'EARLY_DETECTION', isActive: false })];
  await refreshRecurring(deps, 'item-1', 'tok');
  const rows = deps.db.prepare('SELECT stream_id, frequency, average_cents, status, is_active, transaction_ids FROM recurring_streams ORDER BY stream_id').all();
  assert.deepEqual(rows, [
    { stream_id: 's1', frequency: 'monthly', average_cents: 1549, status: 'mature', is_active: 1, transaction_ids: '["t-a","t-b"]' },
    { stream_id: 's2', frequency: 'semi_monthly', average_cents: 1549, status: 'early_detection', is_active: 0, transaction_ids: '["t-a","t-b"]' },
  ]);
  plaid.recurring = [stream('s3'), stream('card', { category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), stream('xfer', { category: 'TRANSFER_OUT_ACCOUNT_TRANSFER' })];
  plaid.failNextRecurring('INTERNAL_SERVER_ERROR');
  await refreshRecurring(deps, 'item-1', 'tok');
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM recurring_streams').get() as { n: number }).n, 2);
  await refreshRecurring(deps, 'item-1', 'tok');
  assert.deepEqual((deps.db.prepare('SELECT stream_id FROM recurring_streams').all() as { stream_id: string }[]).map((r) => r.stream_id), ['s3']);
});

test('normalizeName and addInterval', () => {
  assert.equal(normalizeName('SYNTHETIC.COM #1234 555-012*X'), 'synthetic com x');
  assert.equal(addInterval('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addInterval('2026-03-15', 'monthly'), '2026-04-15');
  assert.equal(addInterval('2026-03-15', 'annually'), '2027-03-15');
  assert.equal(addInterval('2026-03-15', 'semi_monthly'), '2026-03-30');
  assert.equal(addInterval('2026-03-15', 'biweekly'), '2026-03-29');
  assert.equal(addInterval('2026-03-15', 'unknown'), null);
});

test('read model: active plaid streams with overrides, manual items, price up, monthly total, windows', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const ins = db.prepare(`INSERT INTO recurring_streams VALUES (?, 'item-1', ?, ?, ?, ?, ?, ?, ?, ?, 'x', '[]')`);
  ins.run('s-tv', 'Synthetic TV', 'monthly', 1500, 1700, '2026-03-05', '2026-04-05', 1, 'mature');
  ins.run('s-gym', 'Synthetic Gym', 'monthly', 4000, 4000, '2026-02-20', '2026-03-20', 1, 'early_detection');
  ins.run('s-old', 'Synthetic Old', 'monthly', 999, 999, '2025-01-01', null, 0, 'tombstoned');
  ins.run('s-yr', 'Synthetic Yearly', 'annually', 12000, 12000, '2025-06-01', '2026-06-01', 1, 'mature');
  db.prepare("INSERT INTO recurring_overrides (stream_id, name) VALUES ('s-yr', 'Synthetic Renamed')").run();
  seedAccount(db, { id: 'a1', type: 'credit' });
  seedAccount(db, { id: 'a2', type: 'credit' });
  seedTxn(db, { id: 'm1', accountId: 'a1', date: '2026-02-10', amountCents: -999, payee: 'Synthetic Cloud #22', source: 'plaid', sourceId: 'm1' });
  seedTxn(db, { id: 'm2', accountId: 'a2', date: '2026-03-10', amountCents: -999, payee: 'SYNTHETIC CLOUD #23', source: 'plaid', sourceId: 'm2' });
  db.prepare("INSERT INTO recurring_manual VALUES ('man-1', 'Synthetic Cloud', 'synthetic cloud', 'monthly', 'm1', 0, 'x')").run();
  const r = getRecurring(db, '2026-03-15', false);
  assert.deepEqual(r.items.map((i) => [i.id, i.name]), [['man-1', 'Synthetic Cloud'], ['s-gym', 'Synthetic Gym'], ['s-yr', 'Synthetic Renamed'], ['s-tv', 'Synthetic TV']]);
  const tv = r.items.find((i) => i.id === 's-tv')!;
  assert.deepEqual([tv.priceUpCents, tv.variable, tv.monthlyCents], [200, false, 1500]);
  const cloud = r.items.find((i) => i.id === 'man-1')!;
  assert.deepEqual([cloud.lastDate, cloud.nextDate, cloud.amountCents, cloud.source], ['2026-03-10', '2026-04-10', 999, 'manual']);
  assert.equal(r.items.find((i) => i.id === 's-gym')!.isNew, true);
  assert.equal(r.monthlyTotalCents, 1500 + 4000 + 1000 + 999);
  assert.deepEqual(r.upcoming.map((i) => i.id), ['s-gym', 's-tv', 'man-1']);
  assert.equal(r.dueThisWeek, 1);
  db.prepare("INSERT OR REPLACE INTO recurring_overrides (stream_id, hidden) VALUES ('s-tv', 1)").run();
  assert.equal(getRecurring(db, '2026-03-15', false).items.some((i) => i.id === 's-tv'), false);
  assert.equal(getRecurring(db, '2026-03-15', true).items.find((i) => i.id === 's-tv')!.hidden, true);
});

test('a manual item whose text no longer matches falls back to its source transaction; skipped when that is gone too', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedAccount(db, { id: 'a1', type: 'credit' });
  seedTxn(db, { id: 'src', accountId: 'a1', date: '2026-03-02', amountCents: -1234, payee: 'Synthetic Renamed Shop' });
  db.prepare("INSERT INTO recurring_manual VALUES ('man-1', 'Synthetic Shop', 'synthetic shop', 'monthly', 'src', 0, 'x')").run();
  const item = getRecurring(db, '2026-03-15', false).items[0]!;
  assert.deepEqual([item.id, item.lastDate, item.amountCents, item.nextDate], ['man-1', '2026-03-02', 1234, '2026-04-02']);
  db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id = 'src'").run();
  assert.equal(getRecurring(db, '2026-03-15', false).items.length, 0);
});

test('median averages the middle two; a manual item a visible Plaid stream also finds counts once until that stream is hidden', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const ins = db.prepare(`INSERT INTO recurring_streams VALUES (?, 'item-1', ?, 'monthly', 999, 999, '2026-03-10', '2026-04-10', 1, 'mature', 'x', '[]')`);
  ins.run('s1', 'SYNTHETIC CLOUD 4455');
  ins.run('s2', 'Synthetic Other');
  db.prepare("INSERT INTO recurring_overrides (stream_id, name) VALUES ('s2', 'Synthetic Box')").run();
  seedAccount(db, { id: 'a1', type: 'credit' });
  seedTxn(db, { id: 't1', accountId: 'a1', date: '2026-02-10', amountCents: -1000, payee: 'Synthetic Cloud' });
  seedTxn(db, { id: 't2', accountId: 'a1', date: '2026-03-10', amountCents: -1200, payee: 'Synthetic Cloud' });
  seedTxn(db, { id: 't3', accountId: 'a1', date: '2026-03-10', amountCents: -500, payee: 'Synthetic Box' });
  db.prepare("INSERT INTO recurring_manual VALUES ('man-1', 'Synthetic Cloud', 'synthetic cloud', 'monthly', 't1', 0, 'x')").run();
  db.prepare("INSERT INTO recurring_manual VALUES ('man-2', 'Synthetic Box', 'synthetic box', 'monthly', 't3', 0, 'x')").run();
  const r = getRecurring(db, '2026-03-15', true);
  assert.deepEqual(r.items.map((i) => i.id), ['s2', 's1']);
  assert.equal(r.monthlyTotalCents, 999 * 2);
  db.prepare("INSERT INTO recurring_overrides (stream_id, hidden) VALUES ('s1', 1)").run();
  const cloud = getRecurring(db, '2026-03-15', false).items.find((i) => i.id === 'man-1')!;
  assert.equal(cloud.amountCents, 1100);
});

test('past next dates roll forward by whole intervals; windows include today, +7 and +30 but not +8 (week) or +31; unknown has no monthly', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const ins = db.prepare(`INSERT INTO recurring_streams VALUES (?, 'item-1', ?, ?, 100, 100, ?, ?, 1, 'mature', 'x', '[]')`);
  for (const [id, next] of [['d0', '2026-03-15'], ['d7', '2026-03-22'], ['d8', '2026-03-23'], ['d30', '2026-04-14'], ['d31', '2026-04-15']]) {
    ins.run(id, `Synthetic ${id}`, 'monthly', '2026-03-01', next);
  }
  ins.run('past', 'Synthetic Past', 'monthly', '2026-01-10', '2026-02-10');
  ins.run('unk', 'Synthetic Unknown', 'unknown', '2026-03-01', null);
  seedAccount(db, { id: 'a1', type: 'credit' });
  seedTxn(db, { id: 't1', accountId: 'a1', date: '2026-01-31', amountCents: -100, payee: 'Synthetic Gym' });
  db.prepare("INSERT INTO recurring_manual VALUES ('man', 'Synthetic Gym', 'synthetic gym', 'monthly', 't1', 0, 'x')").run();
  const r = getRecurring(db, '2026-03-15', false);
  assert.deepEqual(r.upcoming.map((i) => [i.id, i.nextDate]), [['d0', '2026-03-15'], ['d7', '2026-03-22'], ['d8', '2026-03-23'],
    ['man', '2026-03-31'], ['past', '2026-04-10'], ['d30', '2026-04-14']]);
  assert.equal(r.dueThisWeek, 2);
  assert.equal(r.items.find((i) => i.id === 'unk')!.monthlyCents, null);
  assert.equal(r.monthlyTotalCents, 700);
});
