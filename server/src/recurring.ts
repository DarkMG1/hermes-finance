import type { RecurringItem, RecurringList, Transaction } from '@hermes/shared';
import type { Db } from './db.ts';
import type { Deps } from './deps.ts';
import { PlaidError } from './plaid/port.ts';
import { addDays } from './days.ts';

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

// bank text compares whole (digits kept), so "CHECK 1234" never pools every check
export const bankText = (b: string) => b.toLowerCase().replace(/\s+/g, ' ').trim();

const DAYS: Record<string, number> = { weekly: 7, biweekly: 14, semi_monthly: 15 };
const MONTHS: Record<string, number> = { monthly: 1, annually: 12 };
const FACTOR: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, semi_monthly: 2, monthly: 1, annually: 1 / 12 };

/** k intervals after ymd, counted from ymd so month-end days don't drift. */
export function addInterval(ymd: string, frequency: string, k = 1): string | null {
  if (DAYS[frequency]) {
    const day = addDays(ymd, DAYS[frequency]! * k);
    return day.startsWith('+') ? '9999-12-31' : day;
  }
  if (!MONTHS[frequency]) return null;
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + MONTHS[frequency]! * k, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.getUTCFullYear() > 9999 ? '9999-12-31' : target.toISOString().slice(0, 10);
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

// cancelled by hand with no charge since, or ended with two expected charges missed (three days' grace for posting and month ends); an
// unknown interval never ends on its own
const endState = (last: string, frequency: string, endedOn: string | null, today: string) => {
  const cancelled = endedOn !== null && last <= endedOn;
  const missed = addInterval(last, frequency, 2);
  return { cancelled, ended: cancelled || (missed !== null && Date.parse(missed) + 3 * 86_400_000 < Date.parse(today)) };
};

const monthly = (cents: number, frequency: string) => (FACTOR[frequency] ? Math.round(cents * FACTOR[frequency]!) : null);
const priceUp = (last: number, avg: number) => (last - avg > Math.max(avg * 0.05, 100) ? last - avg : 0);

type StreamRow = { stream_id: string; name: string; frequency: string; average_cents: number; last_cents: number; last_date: string; next_date: string | null;
  status: string; transaction_ids: string; o_hidden: number | null; o_name: string | null; o_frequency: string | null; o_ended_on: string | null };
type ManualRow = { id: string; name: string; match_text: string; frequency: string; source_transaction_id: string | null; hidden: number; ended_on: string | null };
type OutRow = { id: string; date: string; amount_cents: number; names: Set<string> };

/** Every live money-out row, newest first, with its names normalized once. */
// ponytail: one full scan of money-out rows per call; filter in SQL or index a normalized column if it gets slow
export function moneyOut(db: Db): OutRow[] {
  return (db.prepare(`SELECT id, date, amount_cents, payee, merchant_name, bank_description FROM transactions t
      WHERE removed_at IS NULL AND amount_cents < 0 AND person_id IS NULL
        AND (NOT EXISTS (SELECT 1 FROM split_lines s WHERE s.transaction_id = t.id)
          OR EXISTS (SELECT 1 FROM split_lines s WHERE s.transaction_id = t.id AND s.person_id IS NULL AND s.amount_cents < 0))
      ORDER BY date DESC, id DESC`).all() as
    { id: string; date: string; amount_cents: number; payee: string | null; merchant_name: string | null; bank_description: string }[])
    .map((t) => ({ id: t.id, date: t.date, amount_cents: t.amount_cents, names: new Set([t.payee, t.merchant_name, t.bank_description].map((n) => (n ? normalizeName(n) : ''))) }));
}

/** fallback: no money-out row carries the item's text, so it goes by the charge it was made from (History does the same). */
function manualItem(db: Db, m: ManualRow, out: OutRow[], today: string): { item: RecurringItem; fallback: boolean } | null {
  let rows = out.filter((t) => t.names.has(m.match_text)).slice(0, 6);
  const fallback = !rows.length;
  if (fallback && m.source_transaction_id) {
    rows = out.filter((t) => t.id === m.source_transaction_id);
  }
  if (!rows.length) return null;
  const amounts = rows.map((r) => -r.amount_cents).sort((a, b) => a - b);
  const median = Math.round((amounts[Math.floor((amounts.length - 1) / 2)]! + amounts[Math.floor(amounts.length / 2)]!) / 2);
  const { cancelled, ended } = endState(rows[0]!.date, m.frequency, m.ended_on, today);
  return { fallback, item: {
    id: m.id, source: 'manual', name: m.name, frequency: m.frequency as RecurringItem['frequency'], amountCents: median,
    variable: amounts[amounts.length - 1]! - amounts[0]! > median * 0.2, lastDate: rows[0]!.date, lastCents: -rows[0]!.amount_cents,
    nextDate: ended ? null : rollForward(addInterval(rows[0]!.date, m.frequency), rows[0]!.date, m.frequency, today), monthlyCents: monthly(median, m.frequency),
    priceUpCents: priceUp(-rows[0]!.amount_cents, median), isNew: false, hidden: m.hidden === 1, ended, cancelled, stopped: false,
  } };
}

type Bill = { item: RecurringItem; keys: string[]; ids: Set<string>; source: string | null; active: boolean };

/** Every Recurring item with what its charges match, as History matches them: a Plaid stream's charge ids and names, a manual item's text,
 * and its source charge only while no money-out row carries that text. */
function bills(db: Db, today: string): Bill[] {
  // a stream Plaid stopped (inactive, not tombstoned) stays listed as ended
  const streams = db.prepare(`SELECT s.*, o.hidden AS o_hidden, o.name AS o_name, o.frequency AS o_frequency, o.ended_on AS o_ended_on FROM recurring_streams s
      LEFT JOIN recurring_overrides o ON o.stream_id = s.stream_id WHERE s.status != 'tombstoned'`).all() as (StreamRow & { is_active: number })[];
  const all: Bill[] = streams.map((s) => {
    const frequency = (s.o_frequency ?? s.frequency) as RecurringItem['frequency'];
    const { cancelled, ended: missed } = endState(s.last_date, frequency, s.o_ended_on, today);
    const ended = missed || s.is_active === 0;
    const item: RecurringItem = {
      id: s.stream_id, source: 'plaid', name: s.o_name ?? s.name, frequency, amountCents: s.average_cents,
      variable: Math.abs(s.last_cents - s.average_cents) > s.average_cents * 0.2, lastDate: s.last_date, lastCents: s.last_cents,
      nextDate: ended ? null : rollForward(s.o_frequency ? addInterval(s.last_date, frequency) : (s.next_date ?? addInterval(s.last_date, frequency)), s.last_date, frequency, today),
      monthlyCents: monthly(s.average_cents, frequency), priceUpCents: priceUp(s.last_cents, s.average_cents), isNew: s.status === 'early_detection',
      hidden: s.o_hidden === 1, ended, cancelled, stopped: s.is_active === 0,
    };
    return { item, keys: [s.name, item.name].map(normalizeName), ids: new Set(JSON.parse(s.transaction_ids) as string[]), source: null, active: s.is_active === 1 };
  });
  // a bill Plaid also finds shows once, as Plaid's; the manual row comes back if that stream is hidden, stopped or gone
  const plaidKeys = new Set(all.filter((b) => !b.item.hidden && b.active).flatMap((b) => b.keys));
  const manual = db.prepare('SELECT * FROM recurring_manual').all() as ManualRow[];
  const out = manual.length ? moneyOut(db) : [];
  for (const m of manual) {
    const made = plaidKeys.has(m.match_text) ? null : manualItem(db, m, out, today);
    if (made) all.push({ item: made.item, keys: [m.match_text], ids: new Set(), source: made.fallback ? m.source_transaction_id : null, active: true });
  }
  return all;
}

type MemberRow = { id: string; source: string; source_id: string | null; pending: number; payee: string | null; merchant_name: string | null;
  bank_description: string };

/** Reads the visible Recurring items once (ended ones included) and returns which one each row's charge is in the History of: a posted Plaid
 * charge belongs to a stream with ids by id alone; any other row by exact name, or as a manual item's source charge while History falls back
 * to it. Callers pass only rows History can list (owner money out). */
export function memberships(db: Db, today: string): (rows: MemberRow[]) => Map<string, NonNullable<Transaction['recurring']>> {
  let visible: Bill[] | null = null;
  return (rows) => {
    const out = new Map<string, NonNullable<Transaction['recurring']>>();
    if (!rows.length) return out;
    // a charge's own stream id comes first, and an ended twin yields to a live one
    visible ??= bills(db, today).filter((b) => !b.item.hidden).sort((a, b) => Number(a.item.ended) - Number(b.item.ended));
    for (const r of rows) {
      const posted = r.source === 'plaid' && r.pending === 0 && r.source_id !== null;
      const names = [r.payee, r.merchant_name, r.bank_description].map((s) => (s ? normalizeName(s) : '')).filter(Boolean);
      const b = (posted ? visible.find((v) => v.ids.has(r.source_id!)) : undefined)
        ?? visible.find((v) => !(posted && v.ids.size) && (v.source === r.id || v.keys.some((k) => names.includes(k))));
      if (b) out.set(r.id, { id: b.item.id, name: b.item.name, frequency: b.item.frequency });
    }
    return out;
  };
}

export function getRecurring(db: Db, today: string, includeHidden: boolean): RecurringList {
  const all = bills(db, today).map((b) => b.item);
  const visible = all.filter((i) => !i.hidden);
  // an ended item has no next date, so it's never upcoming
  const within = (days: number) => visible.filter((i) => i.nextDate && i.nextDate >= today && Date.parse(i.nextDate) <= Date.parse(today) + days * 86_400_000);
  return {
    upcoming: within(30).sort((a, b) => a.nextDate!.localeCompare(b.nextDate!)),
    items: (includeHidden ? all : visible).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    monthlyTotalCents: visible.reduce((s, i) => s + (i.ended ? 0 : i.monthlyCents ?? 0), 0),
    dueThisWeek: within(7).length,
  };
}
