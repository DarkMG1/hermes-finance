import type { ExpenseRow, ExpensesPage, ExpensesQuery, PayeeHistory, PayeeHistoryQuery, PayeeHistoryRow, Spending, SpendingQuery } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { periodRange } from './ledger.ts';
import { normalizeName } from './recurring.ts';

// Every amount that can count toward Out or In, one row each: the owner's split lines, unsplit untagged transactions, and
// split differences. Bound with (from, toExclusive) three times.
const LINES = `
  WITH lines AS (
    SELECT t.id AS transaction_id, sl.id AS line_id, t.date AS date, t.created_at AS created_at, t.rowid AS row_order,
           COALESCE(sl.payee, t.payee, t.merchant_name, t.bank_description) AS name,
           sl.category_id AS category_id, sl.amount_cents AS amount, t.plaid_category AS plaid_category, 0 AS drift, 1 AS is_split
      FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
     WHERE t.removed_at IS NULL AND t.date >= ? AND t.date < ? AND sl.person_id IS NULL
    UNION ALL
    SELECT t.id, NULL, t.date, t.created_at, t.rowid, COALESCE(t.payee, t.merchant_name, t.bank_description),
           t.category_id, t.amount_cents, t.plaid_category, 0, 0
      FROM transactions t
     WHERE t.removed_at IS NULL AND t.date >= ? AND t.date < ?
       AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
       AND t.person_id IS NULL
    UNION ALL
    -- the bank changed a split transaction's amount: the owner's lines stay as saved and the exact difference
    -- counts as uncategorized spending until they re-split, so the total always matches the bank
    SELECT t.id, NULL, t.date, t.created_at, t.rowid, COALESCE(t.payee, t.merchant_name, t.bank_description),
           NULL, t.amount_cents - SUM(sl.amount_cents), t.plaid_category, 1, 1
      FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
     WHERE t.removed_at IS NULL AND t.date >= ? AND t.date < ?
     GROUP BY t.id HAVING t.amount_cents != SUM(sl.amount_cents)
  )`;

// Out: spending categories, plus uncategorized rows that aren't income, transfers or card payments by Plaid's category. Inflows
// only net when the bank categorized them (refunds), so manual/unknown inflows don't offset spending (a split's drift always nets,
// so a smaller bank amount lowers spending, but keeps the Plaid exclusions).
const OUT = `((lines.category_id IS NOT NULL AND c.is_transfer = 0 AND c.is_income = 0)
  OR (lines.category_id IS NULL AND (lines.drift = 1 OR lines.amount < 0 OR lines.plaid_category IS NOT NULL) AND (lines.plaid_category IS NULL OR NOT (
        lines.plaid_category GLOB 'INCOME*' OR lines.plaid_category GLOB 'TRANSFER_IN*'
        OR lines.plaid_category GLOB 'TRANSFER_OUT*' OR lines.plaid_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'))))`;

// In: income categories only; an uncategorized inflow is never income
const IN = '(lines.category_id IS NOT NULL AND c.is_income = 1)';

function bounds(q: SpendingQuery): { from: string; toExclusive: string; args: string[] } {
  const { from, toExclusive } = periodRange(q);
  return { from, toExclusive, args: [from, toExclusive, from, toExclusive, from, toExclusive] };
}

export function getSpending(db: Db, q: SpendingQuery): Spending {
  const { from, toExclusive, args } = bounds(q);
  const categories = db.prepare(`${LINES}
    SELECT lines.category_id AS categoryId, COALESCE(c.name, 'Uncategorized') AS name, -SUM(lines.amount) AS spentCents
      FROM lines LEFT JOIN categories c ON c.id = lines.category_id
     WHERE ${OUT}
     GROUP BY lines.category_id
    HAVING spentCents != 0
     ORDER BY spentCents DESC, name`).all(...args) as { categoryId: string | null; name: string; spentCents: number }[];
  const { inCents } = db.prepare(`${LINES}
    SELECT COALESCE(SUM(lines.amount), 0) AS inCents FROM lines LEFT JOIN categories c ON c.id = lines.category_id WHERE ${IN}`)
    .get(...args) as { inCents: number };
  const outCents = categories.reduce((s, r) => s + r.spentCents, 0);
  return { from, toExclusive, inCents, outCents, netCents: inCents - outCents, totalCents: outCents, categories };
}

type Cursor = [string, string, number, string];

function encodeCursor(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
function decodeCursor(s: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 4 && typeof v[0] === 'string' && typeof v[1] === 'string' && typeof v[2] === 'number'
      && typeof v[3] === 'string') return [v[0], v[1], v[2], v[3]];
  } catch { /* fall through */ }
  throw new ApiError(400, 'INVALID_REQUEST', 'cursor: invalid cursor', 'cursor');
}

/** The rows behind a Spending number, newest first; a split transaction's lines stay in entry order and its difference comes last. */
export function getExpenses(db: Db, q: ExpensesQuery): ExpensesPage {
  const { args } = bounds({ period: q.period, date: q.date } as SpendingQuery);
  const filters = [q.kind === 'in' ? IN : OUT];
  const filterArgs: unknown[] = [];
  if (q.categoryId === 'uncategorized') filters.push('lines.category_id IS NULL');
  else if (q.categoryId) { filters.push('lines.category_id = ?'); filterArgs.push(q.categoryId); }
  let after = '';
  const afterArgs: unknown[] = [];
  if (q.cursor) {
    const [d, c, r, k] = decodeCursor(q.cursor);
    after = 'WHERE ((date, created_at, row_order) < (?, ?, ?) OR ((date, created_at, row_order) = (?, ?, ?) AND line_key > ?))';
    afterArgs.push(d, c, r, d, c, r, k);
  }
  // line ids are "NN-<uuid>", so '~' sorts after them and a split's difference row comes after its lines
  const rows = db.prepare(`${LINES}, page AS (
      SELECT lines.*, COALESCE(lines.line_id, '~') AS line_key, COALESCE(c.name, 'Uncategorized') AS category_name
        FROM lines LEFT JOIN categories c ON c.id = lines.category_id
       WHERE ${filters.join(' AND ')})
    SELECT * FROM page ${after} ORDER BY date DESC, created_at DESC, row_order DESC, line_key LIMIT ?`)
    .all(...args, ...filterArgs, ...afterArgs, q.limit + 1) as {
      transaction_id: string; line_id: string | null; date: string; created_at: string; row_order: number; name: string;
      category_id: string | null; amount: number; drift: number; is_split: number; line_key: string; category_name: string;
    }[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): ExpenseRow => ({
      transactionId: r.transaction_id, lineId: r.line_id, date: r.date, name: r.name, categoryId: r.category_id, categoryName: r.category_name,
      amountCents: q.kind === 'in' ? r.amount : -r.amount, isSplit: r.is_split === 1, isSplitDifference: r.drift === 1,
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor([last.date, last.created_at, last.row_order, last.line_key]) : null,
  };
}

const monthBack = (today: string, k: number) => new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - k, 1)).toISOString().slice(0, 7);

/** Which of these transactions have a line that counts as spending, i.e. can be in a History; one query for the whole list. */
export function countsAsSpending(db: Db, rows: { id: string; date: string }[]): Set<string> {
  if (rows.length === 0) return new Set();
  const dates = rows.map((r) => r.date).sort();
  const day = [dates[0]!, `${dates[dates.length - 1]}~`]; // '~' sorts after the date, so the range ends with the last day
  return new Set((db.prepare(`${LINES} SELECT DISTINCT lines.transaction_id AS id FROM lines LEFT JOIN categories c ON c.id = lines.category_id
      WHERE lines.transaction_id IN (SELECT value FROM json_each(?)) AND ${OUT}`)
    .all(...day, ...day, ...day, JSON.stringify(rows.map((r) => r.id))) as { id: string }[]).map((r) => r.id));
}

/** One payee's or bill's spending, by the same rules as Expenses: twelve months ending this month, and every matching charge, newest
 * first and paged. A Plaid bill's posted Plaid charges are exactly its stream's; every other row of a bill matches its name exactly, as
 * Recurring does; a payee's name matches as a whole-word prefix. */
export function getPayeeHistory(db: Db, q: PayeeHistoryQuery, today: string): PayeeHistory {
  let name = q.name ?? '';
  let keys = [normalizeName(name)];
  let ids = new Set<string>();
  if (q.recurringId) {
    const s = db.prepare(`SELECT s.name, o.name AS o_name, s.transaction_ids FROM recurring_streams s
        LEFT JOIN recurring_overrides o ON o.stream_id = s.stream_id WHERE s.stream_id = ?`).get(q.recurringId) as { name: string; o_name: string | null; transaction_ids: string } | undefined;
    const m = s ? undefined : db.prepare('SELECT name, match_text FROM recurring_manual WHERE id = ?').get(q.recurringId) as { name: string; match_text: string } | undefined;
    if (s) { name = s.o_name ?? s.name; keys = [s.name, name].map(normalizeName); ids = new Set(JSON.parse(s.transaction_ids) as string[]); }
    else if (m) { name = m.name; keys = [m.match_text]; }
    else throw new ApiError(404, 'NOT_FOUND', 'recurring item not found');
  }
  keys = keys.filter(Boolean);
  if (!ids.size && !keys.length) throw new ApiError(400, 'NO_NAME', 'this name has nothing to match', 'name');
  const all = ['0000-01-01', '9999-12-31'];
  // a payee's "whole foods" matches "whole foods market", not the other way round
  const hit = (s: string | null) => !!s && (q.recurringId ? keys.includes(normalizeName(s)) : `${normalizeName(s)} `.startsWith(`${keys[0]} `));
  // ponytail: full-ledger scan in JS, push the match into SQL if the ledger outgrows it
  const lines = db.prepare(`${LINES}
    SELECT lines.transaction_id, lines.date, lines.created_at, lines.row_order, lines.name, lines.amount, lines.is_split, t.amount_cents AS total,
           t.source, t.source_id, t.pending, t.payee, t.merchant_name, t.bank_description
      FROM lines JOIN transactions t ON t.id = lines.transaction_id LEFT JOIN categories c ON c.id = lines.category_id
     WHERE ${OUT}
     ORDER BY lines.date DESC, lines.created_at DESC, lines.row_order DESC, COALESCE(lines.line_id, '~')`).all(...all, ...all, ...all) as {
      transaction_id: string; date: string; created_at: string; row_order: number; name: string; amount: number; is_split: number; total: number;
      source: string; source_id: string | null; pending: number; payee: string | null; merchant_name: string | null; bank_description: string;
    }[];
  const rows = new Map<string, { row: PayeeHistoryRow; at: Cursor }>();
  for (const l of lines) {
    // pre-cutover imports and pending charges are never in the stream's ids
    const byId = ids.size > 0 && l.source === 'plaid' && !l.pending;
    const whole = byId ? ids.has(l.source_id!) : [l.payee, l.merchant_name, l.bank_description].some(hit);
    // the row is titled by the name that matched; a bill, like Recurring, never matches a split line's own payee
    const named = byId ? whole && l.name : [q.recurringId ? null : l.name, l.payee, l.merchant_name, l.bank_description].find(hit);
    if (!named) continue;
    const r = rows.get(l.transaction_id);
    if (r) r.row.shareCents -= l.amount;
    else {
      rows.set(l.transaction_id, {
        row: { transactionId: l.transaction_id, date: l.date, name: named, shareCents: -l.amount, totalCents: l.is_split && whole ? -l.total : null, upcoming: l.date > today },
        at: [l.date, l.created_at, l.row_order, l.transaction_id],
      });
    }
  }
  const months = Array.from({ length: 12 }, (_, i) => ({ month: monthBack(today, 11 - i), cents: 0 }));
  for (const { row } of rows.values()) {
    if (row.totalCents === row.shareCents) row.totalCents = null; // a self-only split reads as a plain charge
    const m = months.find((x) => x.month === row.date.slice(0, 7));
    if (m && !row.upcoming) m.cents += row.shareCents;
  }
  const totalCents = months.reduce((s, m) => s + m.cents, 0);
  const c = q.cursor ? decodeCursor(q.cursor) : null;
  const after = c ? [...rows.values()].filter(({ at }) => (at[0] !== c[0] ? at[0] < c[0] : at[1] !== c[1] ? at[1] < c[1] : at[2] < c[2])) : [...rows.values()];
  const page = after.slice(0, q.limit);
  return {
    name, months, totalCents, averageCents: Math.round(totalCents / 12), rows: page.map((r) => r.row),
    nextCursor: after.length > q.limit ? encodeCursor(page[page.length - 1]!.at) : null,
  };
}
