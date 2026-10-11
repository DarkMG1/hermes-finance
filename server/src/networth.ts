import type { Db } from './db.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** The owner's day: the date in the process time zone (the TZ env var). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Records today's balance for every account that has one; a later call the same day overwrites. */
export function snapshotBalances(db: Db, day: string): void {
  db.prepare(`
    INSERT INTO balance_snapshots (account_id, date, balance_cents)
    SELECT id, ?, balance_current_cents FROM accounts WHERE balance_current_cents IS NOT NULL
    ON CONFLICT (account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`).run(day);
}
