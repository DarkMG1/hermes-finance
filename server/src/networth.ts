import type { NetWorthHistory, NetWorthQuery } from '@hermes/shared';
import type { Db } from './db.ts';
import { liveNetWorthCents, NEGATIVE_TYPES } from './ledger.ts';

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

const MONTHS: Record<Exclude<NetWorthQuery['range'], 'all'>, number> = { '1m': 1, '3m': 3, '1y': 12 };

/** `day` minus `n` months, clamped to the last day of the target month (Mar 31 - 1 month = Feb 28). */
function minusMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${String(ty).padStart(4, '0')}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function getNetWorth(db: Db, range: NetWorthQuery['range'], today: string): NetWorthHistory {
  const snaps = db.prepare(`
    SELECT s.account_id AS accountId, s.date, s.balance_cents AS cents, a.type FROM balance_snapshots s
    JOIN accounts a ON a.id = s.account_id WHERE a.hidden = 0 AND s.date <= ? ORDER BY s.date`).all(today) as
    { accountId: string; date: string; cents: number; type: string }[];
  const first = snaps[0];
  if (!first) return { points: [], currentCents: liveNetWorthCents(db), changeCents: 0 };
  const wanted = range === 'all' ? first.date : minusMonths(today, MONTHS[range]);
  const start = wanted > first.date ? wanted : first.date;
  // walk every day from the first snapshot so balances set before the window carry into it
  const latest = new Map<string, number>();
  const points: NetWorthHistory['points'] = [];
  let i = 0;
  for (let day = first.date; day <= today; day = nextDay(day)) {
    for (; i < snaps.length && snaps[i]!.date <= day; i += 1) {
      const s = snaps[i]!;
      latest.set(s.accountId, NEGATIVE_TYPES.has(s.type) ? -s.cents : s.cents);
    }
    if (day >= start) points.push({ date: day, netWorthCents: [...latest.values()].reduce((a, b) => a + b, 0) });
  }
  const last = points[points.length - 1]!;
  return { points, currentCents: last.netWorthCents, changeCents: last.netWorthCents - points[0]!.netWorthCents };
}
