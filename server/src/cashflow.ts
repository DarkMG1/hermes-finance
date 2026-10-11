import type { ExpenseRow, ExpensesPage, ExpensesQuery, Spending, SpendingQuery } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { periodRange } from './ledger.ts';

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
