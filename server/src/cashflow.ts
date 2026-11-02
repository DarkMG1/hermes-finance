import type { ExpenseRow, ExpensesPage, ExpensesQuery, PayeeHistory, PayeeHistoryQuery, PayeeHistoryRow, Reimbursements, Spending, SpendingQuery } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { periodRange } from './days.ts';
import { bankText, moneyOut, normalizeName } from './recurring.ts';

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
    -- any residual split difference counts as uncategorized spending so the total matches the transaction
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

// Reimbursed charges (work pays them back) are money movement, not spending, but they still belong in a payee's History: an unsplit
// charge only, never the payback deposit or a split line fronted for someone else.
// ponytail: found by category name, add a category flag if the owner ever renames it
export const REIMBURSEMENT = "(c.is_transfer = 1 AND lower(c.name) LIKE 'reimburs%')";
const REIMBURSED = `(${REIMBURSEMENT} AND lines.is_split = 0 AND lines.amount < 0)`;

// A bill's History counts every charge for it, whatever the category (a monthly investment transfer, an uncategorized Plaid TRANSFER_OUT)
const BILL = `(${OUT} OR ${REIMBURSED} OR lines.amount < 0)`;

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

/** Which of these transactions have a line that can be in a payee's History (spending or reimbursed), and which a line a bill's History
 * counts; one query for the whole list. */
export function historyLines(db: Db, rows: { id: string; date: string }[]): { spending: Set<string>; billable: Set<string> } {
  if (rows.length === 0) return { spending: new Set(), billable: new Set() };
  const dates = rows.map((r) => r.date).sort();
  const day = [dates[0]!, `${dates[dates.length - 1]}~`]; // '~' sorts after the date, so the range ends with the last day
  const hits = db.prepare(`${LINES} SELECT lines.transaction_id AS id, MAX(${OUT} OR ${REIMBURSED}) AS spending, MAX(${BILL}) AS billable
      FROM lines LEFT JOIN categories c ON c.id = lines.category_id
      WHERE lines.transaction_id IN (SELECT value FROM json_each(?)) GROUP BY lines.transaction_id`)
    .all(...day, ...day, ...day, JSON.stringify(rows.map((r) => r.id))) as { id: string; spending: number | null; billable: number | null }[];
  return { spending: new Set(hits.filter((h) => h.spending).map((h) => h.id)), billable: new Set(hits.filter((h) => h.billable).map((h) => h.id)) };
}

/** Whether a payee's History leaves a name out: the longest rule that is a whole-word prefix of it decides ("acme gas" takes "acme gas
 * station" unless that has its own rule), and no rule keeps it in. skip ignores that name's own rule. */
export function excludedBy(db: Db, payee: string): (key: string, skip?: string) => boolean {
  const rules = db.prepare('SELECT excluded_key AS k, excluded FROM history_exclusions WHERE payee_key = ? ORDER BY length(excluded_key) DESC')
    .all(payee) as { k: string; excluded: number }[];
  return (key, skip) => rules.find((r) => r.k !== skip && `${key} `.startsWith(`${r.k} `))?.excluded === 1;
}

/** One payee's or bill's spending, by the same rules as Expenses: twelve months ending this month, and every matching charge, newest
 * first and paged. A Plaid bill's posted Plaid charges are exactly its stream's; every other row of a bill matches its name exactly, as
 * Recurring does (and, like Recurring, falls back to the charge a manual bill was made from); a payee's name matches as a whole-word
 * prefix, and its bank text, when given, matches charges not renamed from that same bank text. */
export function getPayeeHistory(db: Db, q: PayeeHistoryQuery, today: string): PayeeHistory {
  let name = q.name ?? '';
  let keys = [normalizeName(name)];
  let ids = new Set<string>();
  let source: string | null = null;
  if (q.recurringId) {
    const s = db.prepare(`SELECT s.name, o.name AS o_name, s.transaction_ids FROM recurring_streams s
        LEFT JOIN recurring_overrides o ON o.stream_id = s.stream_id WHERE s.stream_id = ?`).get(q.recurringId) as { name: string; o_name: string | null; transaction_ids: string } | undefined;
    const m = s ? undefined : db.prepare('SELECT name, match_text, source_transaction_id FROM recurring_manual WHERE id = ?').get(q.recurringId) as
      { name: string; match_text: string; source_transaction_id: string | null } | undefined;
    if (s) { name = s.o_name ?? s.name; keys = [s.name, name].map(normalizeName); ids = new Set(JSON.parse(s.transaction_ids) as string[]); }
    else if (m) { name = m.name; keys = [m.match_text]; source = m.source_transaction_id; }
    else throw new ApiError(404, 'NOT_FOUND', 'recurring item not found');
  }
  keys = keys.filter(Boolean);
  const bankKey = q.bank ? bankText(q.bank) : '';
  if (!ids.size && !keys.length) throw new ApiError(400, 'NO_NAME', 'this name has nothing to match', 'name');
  const covered = q.recurringId ? () => false : excludedBy(db, keys[0]!);
  const names = new Map<string, { name: string; excluded: boolean }>();
  const all = ['0000-01-01', '9999-12-31'];
  // a payee's "whole foods" matches "whole foods market", not the other way round
  const hit = (s: string | null) => !!s && (q.recurringId ? keys.includes(normalizeName(s)) : `${normalizeName(s)} `.startsWith(`${keys[0]} `));
  // ponytail: full-ledger scan in JS, push the match into SQL if the ledger outgrows it
  const lines = db.prepare(`${LINES}
    SELECT lines.transaction_id, lines.date, lines.created_at, lines.row_order, lines.name, lines.amount, lines.is_split, t.amount_cents AS total,
           t.source, t.source_id, t.pending, t.payee, t.merchant_name, t.bank_description, COALESCE(${REIMBURSED}, 0) AS reimbursed
      FROM lines JOIN transactions t ON t.id = lines.transaction_id LEFT JOIN categories c ON c.id = lines.category_id
     WHERE ${q.recurringId ? BILL : `${OUT} OR ${REIMBURSED}`}
     ORDER BY lines.date DESC, lines.created_at DESC, lines.row_order DESC, COALESCE(lines.line_id, '~')`).all(...all, ...all, ...all) as {
      transaction_id: string; date: string; created_at: string; row_order: number; name: string; amount: number; is_split: number; total: number;
      source: string; source_id: string | null; pending: number; payee: string | null; merchant_name: string | null; bank_description: string;
      reimbursed: number;
    }[];
  const rows = new Map<string, { row: PayeeHistoryRow; at: Cursor }>();
  const collect = (match: (l: (typeof lines)[number]) => { named: string | false | undefined; whole: boolean; prefix?: boolean }) => { for (const l of lines) {
    const { named, whole, prefix } = match(l);
    if (!named) continue;
    const key = normalizeName(named);
    // only a longer spelling of the payee is offered, never bank-text-only titles
    if (prefix && key && key !== keys[0] && !names.has(key)) names.set(key, { name: named, excluded: covered(key) });
    if (covered(key)) continue;
    const r = rows.get(l.transaction_id);
    if (r) { r.row.shareCents -= l.amount; r.row.reimbursed ||= l.reimbursed === 1; }
    else {
      rows.set(l.transaction_id, {
        row: {
          transactionId: l.transaction_id, date: l.date, name: named, shareCents: -l.amount, totalCents: l.is_split && whole ? -l.total : null,
          upcoming: l.date > today, reimbursed: l.reimbursed === 1,
        },
        at: [l.date, l.created_at, l.row_order, l.transaction_id],
      });
    }
  } };
  collect((l) => {
    // pre-cutover imports and pending charges are never in the stream's ids
    const byId = ids.size > 0 && l.source === 'plaid' && !l.pending;
    // a charge renamed away from its bank text was set apart on purpose (APPLE.COM/BILL: iCloud vs Music)
    const bankHit = !!bankKey && bankText(l.bank_description) === bankKey && (l.payee === null || bankText(l.payee) === bankKey);
    const whole = byId ? ids.has(l.source_id!) : bankHit || [l.payee, l.merchant_name, l.bank_description].some(hit);
    // the row is titled by the name that matched; a bill, like Recurring, never matches a split line's own payee
    const found = byId ? undefined : [q.recurringId ? null : l.name, l.payee, l.merchant_name, l.bank_description].find(hit);
    const named = byId ? whole && l.name : found ?? (bankHit ? l.name : undefined);
    return { named, whole, prefix: !q.recurringId && !!found };
  });
  // Recurring's trigger exactly: no money-out charge of any category carries the bill's name
  if (source && !moneyOut(db).some((t) => keys.some((k) => t.names.has(k)))) {
    collect((l) => ({ named: l.transaction_id === source && l.total < 0 && l.amount < 0 && l.name, whole: true }));
  }
  const ordered = [...rows.values()].sort((a, b) => a.at[0] < b.at[0] ? 1 : a.at[0] > b.at[0] ? -1
    : a.at[1] < b.at[1] ? 1 : a.at[1] > b.at[1] ? -1 : b.at[2] - a.at[2]);
  const months = Array.from({ length: 12 }, (_, i) => ({ month: monthBack(today, 11 - i), cents: 0 }));
  // a row someone else paid stores the owner's share; its receipt shows the whole charge
  const paidBy = new Map((db.prepare(`SELECT ri.transaction_id AS id, SUM(ri.amount_cents) + COALESCE(MAX(r.tax_cents), 0) + COALESCE(MAX(r.tip_cents), 0)
      + COALESCE(MAX(r.fees_cents), 0) AS whole
    FROM receipt_items ri JOIN transactions t ON t.id = ri.transaction_id LEFT JOIN receipts r ON r.transaction_id = ri.transaction_id
    WHERE t.paid_by_person_id IS NOT NULL GROUP BY ri.transaction_id`).all() as { id: string; whole: number }[]).map((r) => [r.id, r.whole]));
  for (const { row } of rows.values()) {
    if (row.totalCents === row.shareCents) row.totalCents = null; // a self-only split reads as a plain charge
    const whole = paidBy.get(row.transactionId);
    if (whole !== undefined && whole > row.shareCents) row.totalCents = whole;
    const m = months.find((x) => x.month === row.date.slice(0, 7));
    if (m && !row.upcoming) m.cents += row.shareCents;
  }
  const totalCents = months.reduce((s, m) => s + m.cents, 0);
  // averaged over the months from the first charge (at most 12 back) through this month, or last month while this month has no
  // charge yet, so a new subscription shows its real monthly price
  const first = ordered.at(-1)?.row.date.slice(0, 7) ?? months[11]!.month;
  const last = ordered.some(({ row }) => !row.upcoming && row.date.startsWith(months[11]!.month)) ? 11 : 10;
  const span = Math.max(1, last + 1 - Math.max(0, months.findIndex((m) => m.month >= first)));
  const c = q.cursor ? decodeCursor(q.cursor) : null;
  const shown = ordered.filter(({ row }) => !q.month || row.date.startsWith(q.month));
  const after = c ? shown.filter(({ at }) => (at[0] !== c[0] ? at[0] < c[0] : at[1] !== c[1] ? at[1] < c[1] : at[2] < c[2])) : shown;
  const page = after.slice(0, q.limit);
  return {
    name, months, totalCents, averageCents: Math.round(totalCents / span), rows: page.map((r) => r.row),
    nextCursor: after.length > q.limit ? encodeCursor(page[page.length - 1]!.at) : null,
    names: [...names.values()],
  };
}

/** Reimbursement lines (the owner's own, both signs) for twelve months ending this month, newest first, and each month's charges, paybacks and gap. */
export function getReimbursements(db: Db, today: string): Reimbursements {
  const range = [`${monthBack(today, 11)}-01`, `${monthBack(today, -1)}-01`];
  const lines = db.prepare(`${LINES}
    SELECT lines.transaction_id AS transactionId, lines.line_id AS lineId, lines.date, lines.name, lines.amount AS amountCents
      FROM lines JOIN categories c ON c.id = lines.category_id WHERE ${REIMBURSEMENT}
     ORDER BY lines.date DESC, lines.created_at DESC, lines.row_order DESC, COALESCE(lines.line_id, '~')`)
    .all(...range, ...range, ...range) as Reimbursements['rows'];
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = monthBack(today, i);
    const of = lines.filter((l) => l.date.startsWith(month));
    const outCents = of.reduce((s, l) => s - Math.min(l.amountCents, 0), 0);
    const inCents = of.reduce((s, l) => s + Math.max(l.amountCents, 0), 0);
    return { month, outCents, inCents, unpaidCents: outCents - inCents };
  });
  return { months, rows: lines };
}
