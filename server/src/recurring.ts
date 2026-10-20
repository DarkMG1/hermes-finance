import type { RecurringItem, RecurringList, Transaction } from '@hermes/shared';
import type { Db } from './db.ts';
import type { Deps } from './deps.ts';
import { PlaidError } from './plaid/port.ts';

const cents = (dollars: number) => Math.round(dollars * 100);
// same transfer rule as cashflow/reconcile: card payments and transfers out aren't bills
const isTransfer = (category: string | null) => category === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' || !!category?.startsWith('TRANSFER_OUT');

/** Replaces one Item's stored streams with Plaid's; any failure keeps the old rows and never reaches the sync. */
export async function refreshRecurring(deps: Deps, itemId: string, accessToken: string): Promise<void> {
  try {
    const streams = await deps.plaid.recurringGet(accessToken);
    const now = deps.now().toISOString();
    deps.db.transaction(() => {
      deps.db.prepare('DELETE FROM recurring_streams WHERE item_id = ?').run(itemId);
      const insert = deps.db.prepare(`INSERT INTO recurring_streams (stream_id, item_id, name, frequency, average_cents, last_cents, last_date, next_date, is_active, status, updated_at, transaction_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of streams.filter((x) => !isTransfer(x.category))) {
        insert.run(s.streamId, itemId, s.name, s.frequency.toLowerCase(), cents(s.averageAmount), cents(s.lastAmount), s.lastDate, s.nextDate,
          s.isActive ? 1 : 0, s.status.toLowerCase(), now, JSON.stringify(s.transactionIds));
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

const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** k intervals after ymd, counted from ymd so month-end days don't drift. */
export function addInterval(ymd: string, frequency: string, k = 1): string | null {
  if (DAYS[frequency]) return addDays(ymd, DAYS[frequency]! * k);
  if (!MONTHS[frequency]) return null;
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + MONTHS[frequency]! * k, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** A next date already past (no newer charge yet, or Plaid's prediction is stale) moves on by whole intervals from the last charge. */
function rollForward(next: string | null, last: string, frequency: string, today: string): string | null {
  for (let k = 1; next && next < today; k++) {
    const d = addInterval(last, frequency, k);
    if (!d) break;
    next = d;
  }
  return next;
}

// cancelled by hand with no charge since, or ended with two expected charges missed; an unknown interval never ends on its own
const endState = (last: string, frequency: string, endedOn: string | null, today: string) => {
  const cancelled = endedOn !== null && last <= endedOn;
  return { cancelled, ended: cancelled || (addInterval(last, frequency, 2) ?? today) < today };
};

const monthly = (cents: number, frequency: string) => (FACTOR[frequency] ? Math.round(cents * FACTOR[frequency]!) : null);
const priceUp = (last: number, avg: number) => (last - avg > Math.max(avg * 0.05, 100) ? last - avg : 0);

type StreamRow = { stream_id: string; name: string; frequency: string; average_cents: number; last_cents: number; last_date: string; next_date: string | null;
  status: string; transaction_ids: string; o_hidden: number | null; o_name: string | null; o_frequency: string | null; o_ended_on: string | null };
type ManualRow = { id: string; name: string; match_text: string; frequency: string; source_transaction_id: string | null; hidden: number; ended_on: string | null };
type OutRow = { date: string; amount_cents: number; payee: string | null; merchant_name: string | null; bank_description: string };

function manualItem(db: Db, m: ManualRow, today: string): RecurringItem | null {
  // ponytail: scans every money-out row per manual item; filter in SQL or index a normalized column if it gets slow
  let rows = (db.prepare(`SELECT date, amount_cents, payee, merchant_name, bank_description FROM transactions
      WHERE removed_at IS NULL AND amount_cents < 0 ORDER BY date DESC, id DESC`).all() as OutRow[])
    .filter((t) => [t.payee, t.merchant_name, t.bank_description].some((s) => s && normalizeName(s) === m.match_text)).slice(0, 6);
  if (!rows.length && m.source_transaction_id) {
    rows = db.prepare('SELECT date, amount_cents, payee, merchant_name, bank_description FROM transactions WHERE id = ? AND removed_at IS NULL')
      .all(m.source_transaction_id) as OutRow[];
  }
  if (!rows.length) return null;
  const amounts = rows.map((r) => -r.amount_cents).sort((a, b) => a - b);
  const median = Math.round((amounts[Math.floor((amounts.length - 1) / 2)]! + amounts[Math.floor(amounts.length / 2)]!) / 2);
  const { cancelled, ended } = endState(rows[0]!.date, m.frequency, m.ended_on, today);
  return {
    id: m.id, source: 'manual', name: m.name, frequency: m.frequency as RecurringItem['frequency'], amountCents: median,
    variable: amounts[amounts.length - 1]! - amounts[0]! > median * 0.2, lastDate: rows[0]!.date, lastCents: -rows[0]!.amount_cents,
    nextDate: ended ? null : rollForward(addInterval(rows[0]!.date, m.frequency), rows[0]!.date, m.frequency, today), monthlyCents: monthly(median, m.frequency),
    priceUpCents: priceUp(-rows[0]!.amount_cents, median), isNew: false, hidden: m.hidden === 1, ended, cancelled,
  };
}

/** Every Recurring item with what its charges match: a Plaid stream's charge ids and names, a manual item's text and source charge. */
function bills(db: Db, today: string): { item: RecurringItem; keys: string[]; ids: Set<string>; source: string | null }[] {
  const streams = db.prepare(`SELECT s.*, o.hidden AS o_hidden, o.name AS o_name, o.frequency AS o_frequency, o.ended_on AS o_ended_on FROM recurring_streams s
      LEFT JOIN recurring_overrides o ON o.stream_id = s.stream_id WHERE s.is_active = 1 AND s.status != 'tombstoned'`).all() as StreamRow[];
  const all = streams.map((s) => {
    const frequency = (s.o_frequency ?? s.frequency) as RecurringItem['frequency'];
    const { cancelled, ended } = endState(s.last_date, frequency, s.o_ended_on, today);
    const item: RecurringItem = {
      id: s.stream_id, source: 'plaid', name: s.o_name ?? s.name, frequency, amountCents: s.average_cents,
      variable: Math.abs(s.last_cents - s.average_cents) > s.average_cents * 0.2, lastDate: s.last_date, lastCents: s.last_cents,
      nextDate: ended ? null : rollForward(s.o_frequency ? addInterval(s.last_date, frequency) : (s.next_date ?? addInterval(s.last_date, frequency)), s.last_date, frequency, today),
      monthlyCents: monthly(s.average_cents, frequency), priceUpCents: priceUp(s.last_cents, s.average_cents), isNew: s.status === 'early_detection',
      hidden: s.o_hidden === 1, ended, cancelled,
    };
    return { item, keys: [s.name, item.name].map(normalizeName), ids: new Set(JSON.parse(s.transaction_ids) as string[]), source: null as string | null };
  });
  // a bill Plaid also finds shows once, as Plaid's; the manual row comes back if that stream is hidden or gone
  const plaidKeys = new Set(all.filter((b) => !b.item.hidden).flatMap((b) => b.keys));
  for (const m of db.prepare('SELECT * FROM recurring_manual').all() as ManualRow[]) {
    const item = plaidKeys.has(m.match_text) ? null : manualItem(db, m, today);
    if (item) all.push({ item, keys: [m.match_text], ids: new Set(), source: m.source_transaction_id });
  }
  return all;
}

/** Each row's visible Recurring item, ended ones included: a Plaid stream by charge id first, then any item by name or by the charge it was made from. */
export function recurringOf(db: Db, rows: { id: string; source: string; source_id: string | null; payee: string | null; merchant_name: string | null;
  bank_description: string }[]): Map<string, NonNullable<Transaction['recurring']>> {
  const out = new Map<string, NonNullable<Transaction['recurring']>>();
  if (!rows.length) return out;
  // ponytail: reads every item (and each manual item's charges) once per call; cache per sync if pages get slow
  const visible = bills(db, '0000-01-01').filter((b) => !b.item.hidden); // which item a row belongs to doesn't depend on the day
  for (const r of rows) {
    const names = [r.payee, r.merchant_name, r.bank_description].map((s) => (s ? normalizeName(s) : '')).filter(Boolean);
    const b = visible.find((v) => r.source === 'plaid' && r.source_id !== null && v.ids.has(r.source_id))
      ?? visible.find((v) => v.source === r.id || v.keys.some((k) => names.includes(k)));
    if (b) out.set(r.id, { id: b.item.id, name: b.item.name, frequency: b.item.frequency });
  }
  return out;
}

export function getRecurring(db: Db, today: string, includeHidden: boolean): RecurringList {
  const all = bills(db, today).map((b) => b.item);
  const visible = all.filter((i) => !i.hidden);
  // an ended item has no next date, so it's never upcoming
  const within = (days: number) => visible.filter((i) => i.nextDate && i.nextDate >= today && i.nextDate <= addDays(today, days));
  return {
    upcoming: within(30).sort((a, b) => a.nextDate!.localeCompare(b.nextDate!)),
    items: (includeHidden ? all : visible).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    monthlyTotalCents: visible.reduce((s, i) => s + (i.ended ? 0 : i.monthlyCents ?? 0), 0),
    dueThisWeek: within(7).length,
  };
}
