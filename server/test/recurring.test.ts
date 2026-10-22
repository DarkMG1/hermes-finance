import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addInterval, getRecurring, memberships, normalizeName, refreshRecurring } from '../src/recurring.ts';
import { getPayeeHistory } from '../src/cashflow.ts';
import { addDays } from '../src/days.ts';
import { makeTestDeps, seedAccount, seedItem, seedPerson, seedTxn } from './helpers.ts';

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
  assert.equal(addDays('0099-12-31', 1), '0100-01-01');
  assert.equal(addInterval('0099-12-31', 'weekly'), '0100-01-07');
});

test('a source corrected to an inflow stops being a bill or a fallback History charge', () => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'a1' });
  seedTxn(db, { id: 'src', accountId: 'a1', date: '2026-03-02', amountCents: -1234, payee: 'Synthetic Wren', categoryId: null });
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES ('man', 'Synthetic Quill', 'synthetic quill', 'monthly', 'src', 'x')").run();
  assert.equal(getRecurring(db, '2026-03-15', false).items.length, 1);
  db.prepare("UPDATE transactions SET amount_cents = 1234, plaid_category = 'FOOD_AND_DRINK_COFFEE' WHERE id = 'src'").run();
  assert.deepEqual(getRecurring(db, '2026-03-15', false), { items: [], upcoming: [], monthlyTotalCents: 0, dueThisWeek: 0 });
  assert.deepEqual(getPayeeHistory(db, { recurringId: 'man', limit: 200 }, '2026-03-15').rows, []);
});

test('person-tagged charges neither set a bill price nor suppress its source fallback', () => {
  const { deps: { db } } = makeTestDeps();
  seedAccount(db, { id: 'a1' });
  seedPerson(db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(db, { id: 'src', accountId: 'a1', date: '2026-03-02', amountCents: -1400, payee: 'Synthetic Wren' });
  seedTxn(db, { id: 'tagged', accountId: 'a1', date: '2026-03-14', amountCents: -8800, payee: 'Synthetic Wren', personId: 'p1' });
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES ('man', 'Synthetic Wren', 'synthetic wren', 'monthly', 'src', 'x')").run();
  const item = () => getRecurring(db, '2026-03-15', false).items[0]!;
  assert.deepEqual([item().lastDate, item().lastCents, item().amountCents], ['2026-03-02', 1400, 1400]);
  db.prepare("UPDATE transactions SET payee = 'Synthetic Moss' WHERE id = 'src'").run();
  assert.equal(item().lastCents, 1400);
  assert.deepEqual(getPayeeHistory(db, { recurringId: 'man', limit: 200 }, '2026-03-15').rows.map((r) => r.transactionId), ['src']);
  db.prepare("UPDATE transactions SET person_id = 'p1' WHERE id = 'src'").run();
  assert.equal(getRecurring(db, '2026-03-15', false).items.length, 0);
});

test('membership prefers a live same-name bill by the list day, while explicit stream ids win', () => {
  const { deps, deps: { db } } = makeTestDeps();
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const insert = db.prepare("INSERT INTO recurring_streams VALUES (?, 'i1', 'Synthetic Wren', ?, 1400, 1400, ?, NULL, 1, 'mature', 'x', ?)");
  insert.run('missed', 'monthly', '2026-01-01', '["posted"]');
  insert.run('live', 'annually', '2025-06-01', '[]');
  assert.deepEqual(getRecurring(db, '2026-03-15', false).items.map((i) => [i.id, i.ended]), [['missed', true], ['live', false]]);
  const rows = [{ id: 'manual', source: 'manual', source_id: null, pending: 0, payee: 'Synthetic Wren', merchant_name: null, bank_description: 'SYNTHETIC' },
    { id: 'posted', source: 'plaid', source_id: 'posted', pending: 0, payee: 'Synthetic Wren', merchant_name: null, bank_description: 'SYNTHETIC' }];
  const member = memberships(db, '2026-03-15')(rows);
  assert.equal(member.get('manual')?.id, 'live');
  assert.equal(member.get('posted')?.id, 'missed');
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
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, hidden, created_at) VALUES ('man-1', 'Synthetic Cloud', 'synthetic cloud', 'monthly', 'm1', 0, 'x')").run();
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
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, hidden, created_at) VALUES ('man-1', 'Synthetic Shop', 'synthetic shop', 'monthly', 'src', 0, 'x')").run();
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
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, hidden, created_at) VALUES ('man-1', 'Synthetic Cloud', 'synthetic cloud', 'monthly', 't1', 0, 'x')").run();
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, hidden, created_at) VALUES ('man-2', 'Synthetic Box', 'synthetic box', 'monthly', 't3', 0, 'x')").run();
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
  ins.run('past', 'Synthetic Past', 'monthly', '2026-02-10', '2026-02-10'); // a stale prediction, one charge missed
  ins.run('unk', 'Synthetic Unknown', 'unknown', '2026-03-01', null);
  seedAccount(db, { id: 'a1', type: 'credit' });
  seedTxn(db, { id: 't1', accountId: 'a1', date: '2026-01-31', amountCents: -100, payee: 'Synthetic Gym' });
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, hidden, created_at) VALUES ('man', 'Synthetic Gym', 'synthetic gym', 'monthly', 't1', 0, 'x')").run();
  const r = getRecurring(db, '2026-03-15', false);
  assert.deepEqual(r.upcoming.map((i) => [i.id, i.nextDate]), [['d0', '2026-03-15'], ['d7', '2026-03-22'], ['d8', '2026-03-23'],
    ['man', '2026-03-31'], ['past', '2026-04-10'], ['d30', '2026-04-14']]);
  assert.equal(r.dueThisWeek, 2);
  assert.equal(r.items.find((i) => i.id === 'unk')!.monthlyCents, null);
  assert.equal(r.monthlyTotalCents, 700);
});

test('a bill two expected charges (and three days) behind has ended: no next date, out of upcoming and the totals; unknown never ends', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const ins = db.prepare(`INSERT INTO recurring_streams VALUES (?, 'item-1', ?, ?, 1000, 1000, ?, ?, 1, 'mature', 'x', '[]')`);
  ins.run('gone', 'Synthetic Gone', 'monthly', '2026-01-10', '2026-02-10'); // second missed charge 03-10, grace to 03-13
  ins.run('late', 'Synthetic Late', 'monthly', '2026-01-12', '2026-02-12'); // grace runs out today
  ins.run('unk', 'Synthetic Unknown', 'unknown', '2025-01-01', null);
  seedAccount(db, { id: 'a1', type: 'credit' });
  seedTxn(db, { id: 't1', accountId: 'a1', date: '2026-02-25', amountCents: -500, payee: 'Synthetic Weekly' });
  db.prepare("INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES ('man', 'Synthetic Weekly', 'synthetic weekly', 'weekly', 't1', 'x')").run();
  const r = getRecurring(db, '2026-03-15', false);
  assert.deepEqual(r.items.map((i) => [i.id, i.ended, i.cancelled, i.stopped, i.nextDate]),
    [['gone', true, false, false, null], ['late', false, false, false, '2026-04-12'], ['unk', false, false, false, null], ['man', true, false, false, null]]);
  assert.deepEqual(r.upcoming.map((i) => i.id), ['late']);
  assert.equal(r.monthlyTotalCents, 1000);
  assert.equal(r.dueThisWeek, 0);
  // a new charge brings an auto-ended bill back
  seedTxn(db, { id: 't2', accountId: 'a1', date: '2026-03-14', amountCents: -500, payee: 'Synthetic Weekly' });
  assert.equal(getRecurring(db, '2026-03-15', false).items.find((i) => i.id === 'man')!.ended, false);
});

test('ending counts from the last charge without month-end drift; semi-monthly gets the same grace', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const ins = db.prepare(`INSERT INTO recurring_streams VALUES (?, 'item-1', ?, ?, 1000, 1000, ?, NULL, 1, 'mature', 'x', '[]')`);
  ins.run('eom', 'Synthetic Month End', 'monthly', '2026-01-31'); // charges due 02-28 and 03-31
  ins.run('semi', 'Synthetic Semi', 'semi_monthly', '2026-03-01'); // 1st/16th: the second is 04-01 at the latest
  const ended = (today: string) => getRecurring(db, today, false).items.map((i) => [i.id, i.ended]);
  assert.deepEqual(ended('2026-04-03'), [['eom', false], ['semi', false]]);
  assert.deepEqual(ended('2026-04-04'), [['eom', true], ['semi', true]]);
});

test('a stream Plaid marks inactive is listed as ended, out of upcoming and the totals; a tombstoned one is gone', () => {
  const { deps } = makeTestDeps();
  const { db } = deps;
  seedItem(deps, { id: 'item-1', plaidItemId: 'p1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  const ins = db.prepare(`INSERT INTO recurring_streams VALUES (?, 'item-1', ?, 'monthly', 1000, 1000, '2026-03-01', '2026-04-01', 0, ?, 'x', '[]')`);
  ins.run('off', 'Synthetic Off', 'mature');
  ins.run('dead', 'Synthetic Dead', 'tombstoned');
  const r = getRecurring(db, '2026-03-15', true);
  assert.deepEqual(r.items.map((i) => [i.id, i.ended, i.nextDate]), [['off', true, null]]);
  assert.deepEqual([r.upcoming.length, r.monthlyTotalCents], [0, 0]);
});
