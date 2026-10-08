import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, reconcile, runMigration } from '../src/migrate/run.ts';
import { MigrationError } from '../src/migrate/import.ts';
import type { ActualSnapshot } from '../src/migrate/actual.ts';
import { makeTestDeps, seedAccount, seedItem, seedTxn } from './helpers.ts';

const D = '2026-02-01';
const NOW = new Date('2026-03-15T12:00:00Z');

test('reconcile: depository and credit signs, pending/removed/manual excluded, unsupported types not reconciled', () => {
  const { deps } = makeTestDeps();
  const db = deps.db;
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  seedAccount(db, { id: 'h-dep', itemId: 'i1', plaidAccountId: 'p1', type: 'depository', balanceCents: 85000 });
  seedTxn(db, { id: 'x1', accountId: 'h-dep', source: 'actual', sourceId: 'x1', date: '2025-12-01', amountCents: 100000 });
  seedTxn(db, { id: 'x2', accountId: 'h-dep', source: 'actual', sourceId: 'x2', date: '2026-01-15', amountCents: -20000 });
  seedTxn(db, { id: 'x3', accountId: 'h-dep', source: 'plaid', sourceId: 'x3', date: '2026-01-15', amountCents: -20000, removedAt: '2026-03-15' });
  seedTxn(db, { id: 'x4', accountId: 'h-dep', source: 'plaid', sourceId: 'x4', date: '2026-02-10', amountCents: 5000 });
  seedTxn(db, { id: 'x5', accountId: 'h-dep', source: 'plaid', sourceId: 'x5', date: '2026-02-12', amountCents: -700, pending: true });
  seedTxn(db, { id: 'x6', accountId: 'h-dep', source: 'manual', date: '2026-02-13', amountCents: 999 });
  seedAccount(db, { id: 'h-cc', itemId: 'i1', plaidAccountId: 'p2', type: 'credit', balanceCents: 3000 });
  seedTxn(db, { id: 'y1', accountId: 'h-cc', source: 'plaid', sourceId: 'y1', date: '2026-02-11', amountCents: -3000 });
  seedAccount(db, { id: 'h-miss', itemId: 'i1', plaidAccountId: 'p3', type: 'depository', balanceCents: 1000 });
  seedTxn(db, { id: 'z1', accountId: 'h-miss', source: 'plaid', sourceId: 'z1', date: '2026-02-11', amountCents: -200 });
  seedAccount(db, { id: 'h-loan', itemId: 'i1', plaidAccountId: 'p4', type: 'loan', balanceCents: 50000 });
  seedAccount(db, { id: 'h-own', type: 'other' });
  seedTxn(db, { id: 'w1', accountId: 'h-own', source: 'actual', sourceId: 'w1', date: '2026-01-01', amountCents: 10 });
  seedAccount(db, { id: 'h-empty', type: 'other' });

  const rows = new Map(reconcile(db).map((r) => [r.accountId, r]));
  assert.equal(rows.has('h-empty'), false);
  assert.deepEqual(rows.get('h-dep'), { accountId: 'h-dep', name: 'Account h-dep', type: 'depository', status: 'ok', expectedCents: 85000, ledgerCents: 85000, diffCents: 0, adjustmentCents: 0, boundaryRows: 0 });
  assert.equal(rows.get('h-cc')?.status, 'ok');
  assert.equal(rows.get('h-cc')?.expectedCents, -3000);
  assert.deepEqual([rows.get('h-miss')?.status, rows.get('h-miss')?.diffCents], ['mismatch', -1200]);
  assert.deepEqual([rows.get('h-loan')?.status, rows.get('h-loan')?.expectedCents], ['not_reconciled', null]);
  assert.equal(rows.get('h-own')?.status, 'not_reconciled');
});

function migrationSetup() {
  const { deps } = makeTestDeps();
  const db = deps.db;
  seedItem(deps, { id: 'i1', plaidItemId: 'pi1', institutionName: 'Synthetic Bank', accessToken: 'tok' });
  db.prepare('UPDATE items SET last_synced_at = ?').run(NOW.toISOString());
  seedAccount(db, { id: 'h-chk', itemId: 'i1', plaidAccountId: 'pa-chk', type: 'depository', balanceCents: 85000 });
  seedTxn(db, { id: 'po', accountId: 'h-chk', source: 'plaid', sourceId: 'po', date: '2026-01-15', amountCents: -20000 }); // same purchase Actual has
  seedTxn(db, { id: 'pn', accountId: 'h-chk', source: 'plaid', sourceId: 'pn', date: '2026-02-10', amountCents: 5000 });
  seedTxn(db, { id: 'pp', accountId: 'h-chk', source: 'plaid', sourceId: 'pp', date: '2026-02-12', amountCents: -700, pending: true });
  const snapshot: ActualSnapshot = {
    accounts: [{ id: 'A-chk', name: 'Synthetic Checking', offbudget: false, closed: false }],
    categories: [],
    transactions: [
      { id: 'a-open', accountId: 'A-chk', date: '2025-12-01', amountCents: 100000, categoryId: null, payee: null, importedPayee: null, notes: null, isTransfer: false, lines: [] },
      { id: 'a-x', accountId: 'A-chk', date: '2026-01-15', amountCents: -20000, categoryId: null, payee: null, importedPayee: null, notes: null, isTransfer: false, lines: [] },
      { id: 'a-after', accountId: 'A-chk', date: '2026-02-10', amountCents: 5000, categoryId: null, payee: null, importedPayee: null, notes: null, isTransfer: false, lines: [] },
    ],
  };
  const mapping = { 'A-chk': 'h-chk' };
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { db, snapshot, mapping, count };
}

// The most important test in this plan. Controller: hand-verify by commenting out the retirement loop in
// applyImport — this must then fail with ledger 65000 / diff -20000 (the overlapping purchase counted twice).
test('the boundary: Actual history before D plus Plaid from D reconciles, with the overlapping Plaid row retired', () => {
  const { db, snapshot, mapping } = migrationSetup();
  const r = runMigration(db, snapshot, mapping, { cutoverDate: D, apply: true, now: NOW });
  assert.equal(r.applied, true);
  assert.equal(r.counts.transactions, 2, 'a-after is on/after D and left to Plaid');
  assert.equal(r.counts.retiredPlaid, 1);
  assert.deepEqual(r.report.map((x) => [x.accountId, x.status, x.ledgerCents, x.diffCents]), [['h-chk', 'ok', 85000, 0]]);
});

test('dry run reports the same result and writes nothing', () => {
  const { db, snapshot, mapping, count } = migrationSetup();
  const r = runMigration(db, snapshot, mapping, { cutoverDate: D, apply: false, now: NOW });
  assert.equal(r.applied, false);
  assert.equal(r.report[0]?.status, 'ok');
  assert.equal(count("SELECT COUNT(*) AS n FROM transactions WHERE source = 'actual'"), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM settings'), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM transactions WHERE removed_at IS NOT NULL"), 0);
});

test('apply records itself and refuses to run again, as apply or dry run', () => {
  const { db, snapshot, mapping, count } = migrationSetup();
  runMigration(db, snapshot, mapping, { cutoverDate: D, apply: true, now: NOW });
  const marker = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'actual_migration'").get() as { value: string }).value) as { cutoverDate: string };
  assert.equal(marker.cutoverDate, D);
  const before = count('SELECT COUNT(*) AS n FROM transactions');
  for (const apply of [true, false]) {
    assert.throws(() => runMigration(db, snapshot, mapping, { cutoverDate: D, apply, now: NOW }), (e: unknown) => e instanceof MigrationError && /already applied/.test(e.message));
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM transactions'), before);
});

test('refuses bad or future cutover dates, a conflicting stored cutover, and banks without a first sync', () => {
  const { db, snapshot, mapping } = migrationSetup();
  const run = (cutoverDate: string) => () => runMigration(db, snapshot, mapping, { cutoverDate, apply: false, now: NOW });
  for (const bad of ['2026-02-30', '2026/02/01', 'Feb 1']) assert.throws(run(bad), /real YYYY-MM-DD/);
  assert.throws(run('2026-03-16'), /in the future/);
  db.prepare("INSERT INTO settings (key, value) VALUES ('cutover_date', '2026-01-01')").run();
  assert.throws(run(D), /already set to a different cutover/);
  db.prepare("DELETE FROM settings WHERE key = 'cutover_date'").run();
  db.prepare("INSERT INTO items (id, plaid_item_id, institution_name, access_token_enc) VALUES ('i2', 'pi2', 'Synthetic Bank 2', 'x')").run();
  assert.throws(run(D), /first sync/);
});

test('refuses when no bank is linked yet', () => {
  const { deps } = makeTestDeps();
  const snapshot: ActualSnapshot = { accounts: [], categories: [], transactions: [] };
  assert.throws(() => runMigration(deps.db, snapshot, {}, { cutoverDate: D, apply: false, now: NOW }), /first sync/);
});

test('formatReport ends with a summary line that carries counts but no amounts or names', () => {
  const { db, snapshot, mapping } = migrationSetup();
  const text = formatReport(runMigration(db, snapshot, mapping, { cutoverDate: D, apply: false, now: NOW }));
  const summary = text.trim().split('\n').at(-1) ?? '';
  assert.match(text, /^DRY RUN/);
  assert.match(summary, /^summary: applied=false accounts=1 ok=1 mismatch=0 not_reconciled=0 transactions=2 /);
  assert.doesNotMatch(summary, /850|Synthetic|Account/);
});

test('adjust closes the gap with an adjustment row, reported per account and in the summary and marker', () => {
  const { db, snapshot, mapping } = migrationSetup();
  db.prepare("UPDATE accounts SET balance_current_cents = 90000 WHERE id = 'h-chk'").run();
  const r = runMigration(db, snapshot, mapping, { cutoverDate: D, cutovers: { 'A-chk': D }, adjust: true, apply: true, now: NOW });
  assert.equal(r.counts.adjustments, 1);
  assert.deepEqual(r.report.map((x) => [x.accountId, x.status, x.ledgerCents, x.diffCents, x.adjustmentCents]), [['h-chk', 'ok', 90000, 0, 5000]]);
  const text = formatReport(r);
  assert.match(text, /adjust/);
  assert.match(text.trim().split('\n').at(-1) ?? '', / adjustments=1( |$)/);
  const marker = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'actual_migration'").get() as { value: string }).value) as { cutovers: unknown; adjust: unknown };
  assert.deepEqual([marker.cutovers, marker.adjust], [{ 'A-chk': D }, true]);
  db.prepare("UPDATE transactions SET removed_at = 'x' WHERE source_id = 'adjustment:h-chk'").run();
  assert.equal(reconcile(db)[0]?.adjustmentCents, 0, 'a removed adjustment is not reported');
});

test('boundaryRows counts posted Plaid rows on/after the cutover whose purchase or pending row predates it', () => {
  const { db, snapshot, mapping } = migrationSetup();
  seedAccount(db, { id: 'h-card', itemId: 'i1', plaidAccountId: 'pa-card', type: 'credit', balanceCents: 0 });
  seedTxn(db, { id: 'c1', accountId: 'h-card', source: 'plaid', sourceId: 'c1', date: '2026-02-02', amountCents: -1200 });
  db.prepare("UPDATE transactions SET authorized_date = '2026-01-30' WHERE id = 'c1'").run();
  seedAccount(db, { id: 'h-sav', itemId: 'i1', plaidAccountId: 'pa-sav', type: 'depository', balanceCents: 0 });
  seedTxn(db, { id: 's0', accountId: 'h-sav', source: 'plaid', sourceId: 's0', date: '2026-01-31', amountCents: -300, pending: true, removedAt: '2026-02-03' });
  seedTxn(db, { id: 's1', accountId: 'h-sav', source: 'plaid', sourceId: 's1', date: '2026-02-03', amountCents: -300 });
  seedTxn(db, { id: 's2', accountId: 'h-sav', source: 'plaid', sourceId: 's2', date: '2026-02-04', amountCents: -100 });
  db.prepare("UPDATE transactions SET pending_source_id = 's0' WHERE id = 's1'").run();
  const snap: ActualSnapshot = { ...snapshot, accounts: [...snapshot.accounts,
    { id: 'A-card', name: 'Synthetic Card', offbudget: false, closed: false }, { id: 'A-sav', name: 'Synthetic Savings', offbudget: false, closed: false }] };
  const r = runMigration(db, snap, { ...mapping, 'A-card': 'h-card', 'A-sav': 'h-sav' }, { cutoverDate: D, apply: false, now: NOW });
  const rows = new Map(r.report.map((x) => [x.accountId, x.boundaryRows]));
  assert.deepEqual([rows.get('h-card'), rows.get('h-sav'), rows.get('h-chk')], [1, 1, 0]);
  const text = formatReport(r);
  assert.match(text, /boundary/);
  assert.match(text.trim().split('\n').at(-1) ?? '', / boundary_rows=2( |$)/);
});

test('refuses bad, future, unmapped or non-Hermes per-account cutovers, naming the account', () => {
  const { db, snapshot } = migrationSetup();
  const run = (mapping: Record<string, string>, cutovers: Record<string, string>) => () => runMigration(db, snapshot, mapping, { cutoverDate: D, cutovers, apply: false, now: NOW });
  const named = (re: RegExp) => (e: unknown) => e instanceof MigrationError && /A-chk/.test(e.message) && re.test(e.message);
  assert.throws(run({ 'A-chk': 'h-chk' }, { 'A-chk': '2026-02-30' }), named(/real YYYY-MM-DD/));
  assert.throws(run({ 'A-chk': 'h-chk' }, { 'A-chk': '2026-03-16' }), named(/in the future/));
  assert.throws(run({ 'A-chk': 'new' }, { 'A-chk': D }), named(/Hermes account/));
  assert.throws(run({ 'A-chk': 'skip' }, { 'A-chk': D }), named(/Hermes account/));
  assert.throws(run({ 'A-chk': 'h-chk' }, { 'A-zzz': D }), (e: unknown) => e instanceof MigrationError && /A-zzz/.test(e.message));
});
