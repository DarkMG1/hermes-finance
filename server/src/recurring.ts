import type { RecurringItem, RecurringList } from '@hermes/shared';
import type { Db } from './db.ts';
import type { Deps } from './deps.ts';
import { PlaidError } from './plaid/port.ts';

const cents = (dollars: number) => Math.round(dollars * 100);

/** Replaces one Item's stored streams with Plaid's; any failure keeps the old rows and never reaches the sync. */
export async function refreshRecurring(deps: Deps, itemId: string, accessToken: string): Promise<void> {
  try {
    const streams = await deps.plaid.recurringGet(accessToken);
    const now = deps.now().toISOString();
    deps.db.transaction(() => {
      deps.db.prepare('DELETE FROM recurring_streams WHERE item_id = ?').run(itemId);
      const insert = deps.db.prepare(`INSERT INTO recurring_streams (stream_id, item_id, name, frequency, average_cents, last_cents, last_date, next_date, is_active, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of streams) {
        insert.run(s.streamId, itemId, s.name, s.frequency.toLowerCase(), cents(s.averageAmount), cents(s.lastAmount), s.lastDate, s.nextDate,
          s.isActive ? 1 : 0, s.status.toLowerCase(), now);
      }
    })();
  } catch (e) {
    console.error(`[hermes] recurring refresh failed code=${e instanceof PlaidError ? e.code : 'UNKNOWN'}`);
  }
}

export const normalizeName = (s: string) => s.toLowerCase().replace(/#\d+/g, ' ').replace(/\d{3,}/g, ' ').replace(/\*/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const DAYS: Record<string, number> = { weekly: 7, biweekly: 14, semi_monthly: 15 };
const MONTHS: Record<string, number> = { monthly: 1, annually: 12 };
const FACTOR: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, semi_monthly: 2, monthly: 1, annually: 1 / 12 };

export function addInterval(ymd: string, frequency: string): string | null {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  if (DAYS[frequency]) return new Date(Date.UTC(y, m - 1, d + DAYS[frequency]!)).toISOString().slice(0, 10);
  if (!MONTHS[frequency]) return null;
  const target = new Date(Date.UTC(y, m - 1 + MONTHS[frequency]!, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const monthly = (cents: number, frequency: string) => (FACTOR[frequency] ? Math.round(cents * FACTOR[frequency]!) : null);
const priceUp = (last: number, avg: number) => (last - avg > Math.max(avg * 0.05, 100) ? last - avg : 0);

type StreamRow = { stream_id: string; name: string; frequency: string; average_cents: number; last_cents: number; last_date: string; next_date: string | null;
  status: string; o_hidden: number | null; o_name: string | null; o_frequency: string | null };
type ManualRow = { id: string; name: string; match_text: string; frequency: string; source_transaction_id: string | null; hidden: number };
type OutRow = { date: string; amount_cents: number; payee: string | null; merchant_name: string | null; bank_description: string };

function manualItem(db: Db, m: ManualRow): RecurringItem | null {
  let rows = (db.prepare(`SELECT date, amount_cents, payee, merchant_name, bank_description FROM transactions
      WHERE removed_at IS NULL AND amount_cents < 0 ORDER BY date DESC, id DESC`).all() as OutRow[])
    .filter((t) => [t.payee, t.merchant_name, t.bank_description].some((s) => s && normalizeName(s) === m.match_text)).slice(0, 6);
  if (!rows.length && m.source_transaction_id) {
    rows = db.prepare('SELECT date, amount_cents, payee, merchant_name, bank_description FROM transactions WHERE id = ? AND removed_at IS NULL')
      .all(m.source_transaction_id) as OutRow[];
  }
  if (!rows.length) return null;
  const amounts = rows.map((r) => -r.amount_cents).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)]!;
  return {
    id: m.id, source: 'manual', name: m.name, frequency: m.frequency as RecurringItem['frequency'], amountCents: median,
    variable: amounts[amounts.length - 1]! - amounts[0]! > median * 0.2, lastDate: rows[0]!.date, lastCents: -rows[0]!.amount_cents,
    nextDate: addInterval(rows[0]!.date, m.frequency), monthlyCents: monthly(median, m.frequency), priceUpCents: priceUp(-rows[0]!.amount_cents, median),
    isNew: false, hidden: m.hidden === 1,
  };
}

export function getRecurring(db: Db, today: string, includeHidden: boolean): RecurringList {
  const streams = db.prepare(`SELECT s.*, o.hidden AS o_hidden, o.name AS o_name, o.frequency AS o_frequency FROM recurring_streams s
      LEFT JOIN recurring_overrides o ON o.stream_id = s.stream_id WHERE s.is_active = 1 AND s.status != 'tombstoned'`).all() as StreamRow[];
  const all: RecurringItem[] = streams.map((s) => {
    const frequency = (s.o_frequency ?? s.frequency) as RecurringItem['frequency'];
    return {
      id: s.stream_id, source: 'plaid', name: s.o_name ?? s.name, frequency, amountCents: s.average_cents,
      variable: Math.abs(s.last_cents - s.average_cents) > s.average_cents * 0.2, lastDate: s.last_date, lastCents: s.last_cents,
      nextDate: s.o_frequency ? addInterval(s.last_date, frequency) : (s.next_date ?? addInterval(s.last_date, frequency)),
      monthlyCents: monthly(s.average_cents, frequency), priceUpCents: priceUp(s.last_cents, s.average_cents), isNew: s.status === 'early_detection',
      hidden: s.o_hidden === 1,
    };
  });
  for (const m of db.prepare('SELECT * FROM recurring_manual').all() as ManualRow[]) {
    const item = manualItem(db, m);
    if (item) all.push(item);
  }
  const visible = all.filter((i) => !i.hidden);
  const within = (days: number) => visible.filter((i) => i.nextDate && i.nextDate >= today && i.nextDate <= addDays(today, days));
  return {
    upcoming: within(30).sort((a, b) => a.nextDate!.localeCompare(b.nextDate!)),
    items: (includeHidden ? all : visible).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    monthlyTotalCents: visible.reduce((s, i) => s + (i.monthlyCents ?? 0), 0),
    dueThisWeek: within(7).length,
  };
}
