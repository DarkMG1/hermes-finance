import type { NetWorthHistory, NetWorthQuery } from '@hermes/shared';
import type { Db } from './db.ts';
import { addDays } from './days.ts';
import { type AccountEstimate, loadAccountEstimate } from './backfill.ts';
import { liveNetWorthCents, NEGATIVE_TYPES } from './ledger.ts';

export { localDay } from './days.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** Records today's balances; an unavailable linked account contributes zero without losing its history. A later call overwrites. */
export function snapshotBalances(db: Db, day: string): void {
  db.prepare(`
    INSERT INTO balance_snapshots (account_id, date, balance_cents)
    SELECT id, ?, COALESCE(balance_current_cents, 0) FROM accounts
      WHERE balance_current_cents IS NOT NULL OR (item_id IS NOT NULL AND balance_at IS NOT NULL)
    ON CONFLICT (account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`).run(day);
}

export const MONTHS: Record<Exclude<NetWorthQuery['range'], 'all'>, number> = { '1m': 1, '3m': 3, '1y': 12 };

/** `day` minus `n` months, clamped to the last day of the target month (Mar 31 - 1 month = Feb 28). */
export function minusMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${String(ty).padStart(4, '0')}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}

/** Rebuilt from transactions before their first snapshot; every other type holds flat at it. */
const REBUILT_TYPES = ['depository', 'credit', 'loan'];

type NetWorthFilter = { type?: string; accountIds?: string[] };

export function getNetWorth(db: Db, range: NetWorthQuery['range'], today: string, filter: NetWorthFilter = {}): NetWorthHistory {
  const type = filter.type ?? null;
  const ids = filter.accountIds;
  const idClause = ids ? `AND a.id IN (${ids.map(() => '?').join(', ')})` : '';
  const idArgs = ids ?? [];
  const snaps = db.prepare(`
    SELECT s.account_id AS accountId, s.date, s.balance_cents AS cents, a.type FROM balance_snapshots s
    JOIN accounts a ON a.id = s.account_id WHERE a.hidden = 0 AND s.date <= ? AND (? IS NULL OR a.type = ?) ${idClause} ORDER BY s.date`).all(today, type, type, ...idArgs) as
    { accountId: string; date: string; cents: number; type: string }[];
  const first = snaps[0];
  if (!first) return { points: [], currentCents: liveNetWorthCents(db, type, ids), changeCents: 0, estimatedThrough: null };
  const signed = (s: { cents: number; type: string }) => (NEGATIVE_TYPES.has(s.type) ? -s.cents : s.cents);
  // each account's first snapshot (S) anchors its estimate for every earlier day
  const anchors = new Map<string, string>();
  const latest = new Map<string, number>();
  for (const s of snaps) {
    if (anchors.has(s.accountId)) continue;
    anchors.set(s.accountId, s.date);
    latest.set(s.accountId, signed(s));
  }
  // investment accounts: estimated from investment transactions and prices before their first snapshot
  const estimates = new Map<string, AccountEstimate>();
  const seen = new Set<string>();
  for (const s of snaps) {
    if (s.type !== 'investment' || seen.has(s.accountId)) continue;
    seen.add(s.accountId);
    const est = loadAccountEstimate(db, s.accountId);
    if (est) estimates.set(s.accountId, est);
  }
  // counted transactions per account and day, up to and including S; v(d) = v(S) - (moves in (d, S])
  const moves = db.prepare(`
    SELECT t.account_id AS accountId, t.date, SUM(t.amount_cents) AS cents FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE a.hidden = 0 AND a.type IN (${REBUILT_TYPES.map(() => '?').join(', ')}) AND (? IS NULL OR a.type = ?) ${idClause} AND t.pending = 0 AND t.removed_at IS NULL
      AND t.date <= (SELECT MIN(s.date) FROM balance_snapshots s WHERE s.account_id = t.account_id AND s.date <= ?)
    GROUP BY t.account_id, t.date ORDER BY t.date`).all(...REBUILT_TYPES, type, type, ...idArgs, today) as { accountId: string; date: string; cents: number }[];
  // start every account at its balance before anything recorded, then add each day's moves walking forward
  for (const m of moves) latest.set(m.accountId, latest.get(m.accountId)! - m.cents);
  const lastAnchor = [...anchors.values()].reduce((a, b) => (b > a ? b : a));
  const earliest = [...estimates.values()].reduce((e, est) => (est.earliest < e ? est.earliest : e),
    moves[0] && moves[0].date < first.date ? moves[0].date : first.date);
  const wanted = range === 'all' ? earliest : minusMonths(today, MONTHS[range]);
  const start = wanted > earliest ? wanted : earliest;
  const points: NetWorthHistory['points'] = [];
  let estimatedThrough: string | null = null;
  let i = 0;
  let j = 0;
  for (let day = earliest; day <= today; day = addDays(day, 1)) {
    for (; j < moves.length && moves[j]!.date <= day; j += 1) {
      const m = moves[j]!;
      latest.set(m.accountId, latest.get(m.accountId)! + m.cents);
    }
    // on and after S the real snapshot wins
    for (; i < snaps.length && snaps[i]!.date <= day; i += 1) latest.set(snaps[i]!.accountId, signed(snaps[i]!));
    for (const [accountId, est] of estimates) if (day < anchors.get(accountId)!) latest.set(accountId, est.valueOn(day).totalCents);
    if (day < start) continue;
    points.push({ date: day, netWorthCents: [...latest.values()].reduce((a, b) => a + b, 0) });
    if (day < lastAnchor) estimatedThrough = day;
  }
  const last = points[points.length - 1]!;
  return { points, currentCents: last.netWorthCents, changeCents: last.netWorthCents - points[0]!.netWorthCents, estimatedThrough };
}
