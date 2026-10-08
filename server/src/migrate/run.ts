import type { Db } from '../db.ts';
import { getCutoverDate } from '../sync/apply.ts';
import type { ActualSnapshot } from './actual.ts';
import { applyImport, MigrationError, type AccountMapping, type ImportCounts } from './import.ts';

export type ReconcileRow = {
  accountId: string; name: string; type: string; status: 'ok' | 'mismatch' | 'not_reconciled';
  expectedCents: number | null; ledgerCents: number; diffCents: number | null;
};
export type MigrationResult = { applied: boolean; counts: ImportCounts; report: ReconcileRow[] };

export function reconcile(db: Db): ReconcileRow[] {
  const rows = db.prepare(`
    SELECT a.id, a.name, a.type, a.plaid_account_id AS plaidId, a.balance_current_cents AS balance,
      COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
        WHERE t.account_id = a.id AND t.source IN ('actual', 'plaid') AND t.removed_at IS NULL AND t.pending = 0), 0) AS ledger
    FROM accounts a
    WHERE a.plaid_account_id IS NOT NULL OR EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id AND t.source = 'actual')
    ORDER BY a.name, a.id`).all() as { id: string; name: string; type: string; plaidId: string | null; balance: number | null; ledger: number }[];
  return rows.map((r) => {
    const base = { accountId: r.id, name: r.name, type: r.type, ledgerCents: r.ledger };
    const sign = r.type === 'depository' ? 1 : r.type === 'credit' ? -1 : 0;
    if (sign === 0 || r.plaidId === null || r.balance === null) return { ...base, status: 'not_reconciled', expectedCents: null, diffCents: null };
    const expected = sign * r.balance;
    const diff = r.ledger - expected;
    return { ...base, status: diff === 0 ? 'ok' : 'mismatch', expectedCents: expected, diffCents: diff };
  });
}

class DryRunRollback extends Error {}

function isRealDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export function runMigration(db: Db, snapshot: ActualSnapshot, mapping: AccountMapping, opts: { cutoverDate: string; apply: boolean; now: Date }): MigrationResult {
  const { cutoverDate } = opts;
  if (!isRealDate(cutoverDate)) throw new MigrationError('cutover must be a real YYYY-MM-DD date');
  if (cutoverDate > opts.now.toISOString().slice(0, 10)) throw new MigrationError('cutover date is in the future');
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'actual_migration'").get()) throw new MigrationError('Actual migration already applied');
  const stored = getCutoverDate(db);
  if (stored !== null && stored !== cutoverDate) throw new MigrationError('the database is already set to a different cutover date');
  const items = db.prepare('SELECT COUNT(*) AS n, COUNT(last_synced_at) AS synced FROM items').get() as { n: number; synced: number };
  if (items.n === 0 || items.synced < items.n) throw new MigrationError('every linked bank must finish a first sync before migrating');

  const out: { result?: MigrationResult } = {}; // a holder, so TS doesn't narrow away the closure's assignment
  try {
    db.transaction(() => {
      const nowIso = opts.now.toISOString();
      const counts = applyImport(db, snapshot, mapping, { cutoverDate, nowIso });
      const report = reconcile(db);
      if (opts.apply) {
        db.prepare("INSERT INTO settings (key, value) VALUES ('actual_migration', ?)").run(JSON.stringify({ appliedAt: nowIso, cutoverDate, counts }));
      }
      out.result = { applied: opts.apply, counts, report };
      if (!opts.apply) throw new DryRunRollback(); // rolls the whole transaction back
    })();
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  if (!out.result) throw new Error('migration produced no result');
  return out.result;
}

const money = (c: number | null): string => (c === null ? '-' : (c / 100).toFixed(2));

export function formatReport(r: MigrationResult): string {
  const n = (s: ReconcileRow['status']) => r.report.filter((x) => x.status === s).length;
  const c = r.counts;
  return [
    r.applied ? 'APPLIED' : 'DRY RUN (nothing written)',
    `${'status'.padEnd(15)}${'type'.padEnd(12)}${'expected'.padStart(13)}${'ledger'.padStart(13)}${'diff'.padStart(11)}  account`,
    ...r.report.map((x) => `${x.status.toUpperCase().padEnd(15)}${x.type.padEnd(12)}${money(x.expectedCents).padStart(13)}${money(x.ledgerCents).padStart(13)}${money(x.diffCents).padStart(11)}  ${x.name}`),
    `summary: applied=${r.applied} accounts=${r.report.length} ok=${n('ok')} mismatch=${n('mismatch')} not_reconciled=${n('not_reconciled')} `
      + `transactions=${c.transactions} split_lines=${c.splitLines} split_remainders=${c.splitRemainders} orphan_categories=${c.orphanCategories} `
      + `categories=${c.categories} accounts_created=${c.accountsCreated} retired_plaid=${c.retiredPlaid}`,
  ].join('\n');
}
