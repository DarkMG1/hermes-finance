import type { Account, Category, Home, ListTransactionsQuery, Spending, SpendingQuery, SplitLine, Transaction, TransactionPage } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';

export type TxnRow = {
  id: string; account_id: string; source: 'plaid' | 'manual' | 'actual' | 'applecard'; date: string; amount_cents: number;
  bank_description: string; merchant_name: string | null; pending: number; category_id: string | null;
  payee: string | null; notes: string | null; person_id: string | null; paid_by_person_id: string | null; repayment_dismissed: number;
};

export const TXN_COLS = 'id, account_id, source, date, amount_cents, bank_description, merchant_name, pending, category_id, payee, notes, person_id, '
  + 'paid_by_person_id, repayment_dismissed';

export function rowToTransaction(db: Db, r: TxnRow): Transaction {
  const lines = db.prepare('SELECT id, amount_cents, category_id, notes, person_id FROM split_lines WHERE transaction_id = ? ORDER BY id').all(r.id) as
    { id: string; amount_cents: number; category_id: string | null; notes: string | null; person_id: string | null }[];
  const splitLines: SplitLine[] = lines.map((l) => ({ id: l.id, amountCents: l.amount_cents, categoryId: l.category_id, notes: l.notes, personId: l.person_id }));
  return {
    id: r.id, accountId: r.account_id, source: r.source, date: r.date, amountCents: r.amount_cents,
    payee: r.payee ?? r.merchant_name ?? r.bank_description, bankDescription: r.bank_description,
    merchantName: r.merchant_name, pending: r.pending === 1, categoryId: r.category_id, notes: r.notes, personId: r.person_id, paidByPersonId: r.paid_by_person_id, repaymentDismissed: r.repayment_dismissed === 1, splitLines,
  };
}

export function listAccounts(db: Db): Account[] {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY hidden, COALESCE(display_name, name)').all() as {
    id: string; item_id: string | null; name: string; mask: string | null; type: string; subtype: string | null;
    balance_current_cents: number | null; balance_available_cents: number | null; balance_at: string | null; hidden: number;
    display_name: string | null;
  }[];
  return rows.map((a) => ({
    id: a.id, itemId: a.item_id, name: a.display_name ?? a.name, mask: a.mask, type: a.type, subtype: a.subtype,
    balanceCurrentCents: a.balance_current_cents, balanceAvailableCents: a.balance_available_cents, balanceAt: a.balance_at, hidden: a.hidden === 1,
  }));
}

export function listCategories(db: Db): Category[] {
  const rows = db.prepare('SELECT * FROM categories ORDER BY group_name, name').all() as {
    id: string; name: string; group_name: string; is_income: number; is_transfer: number; hidden: number;
  }[];
  return rows.map((c) => ({ id: c.id, name: c.name, groupName: c.group_name, isIncome: c.is_income === 1, isTransfer: c.is_transfer === 1, hidden: c.hidden === 1 }));
}

export function getTransaction(db: Db, id: string): Transaction | null {
  const row = db.prepare(`SELECT ${TXN_COLS} FROM transactions WHERE id = ? AND removed_at IS NULL`).get(id) as TxnRow | undefined;
  return row ? rowToTransaction(db, row) : null;
}

function encodeCursor(date: string, id: string): string { return Buffer.from(JSON.stringify([date, id])).toString('base64url'); }
function decodeCursor(c: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch { /* fall through */ }
  throw new ApiError(400, 'INVALID_REQUEST', 'cursor: invalid cursor', 'cursor');
}

export function listTransactions(db: Db, q: ListTransactionsQuery): TransactionPage {
  const where = ['removed_at IS NULL'];
  const args: unknown[] = [];
  if (q.accountId) { where.push('account_id = ?'); args.push(q.accountId); }
  if (q.categoryId) {
    where.push('(category_id = ? OR EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = transactions.id AND sl.category_id = ?))');
    args.push(q.categoryId, q.categoryId);
  }
  if (q.personId) {
    where.push(`(person_id = ? OR paid_by_person_id = ?
      OR EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = transactions.id AND sl.person_id = ?))`);
    args.push(q.personId, q.personId, q.personId);
  }
  if (q.from) { where.push('date >= ?'); args.push(q.from); }
  if (q.to) { where.push('date <= ?'); args.push(q.to); }
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    // people's names count too: a row tagged with them, paid by them, or with a split line for them
    where.push(`(COALESCE(payee, '') LIKE ? ESCAPE '\\' OR COALESCE(merchant_name, '') LIKE ? ESCAPE '\\' OR bank_description LIKE ? ESCAPE '\\'
      OR COALESCE(notes, '') LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM people p WHERE p.name LIKE ? ESCAPE '\\' AND (p.id = transactions.person_id OR p.id = transactions.paid_by_person_id
        OR EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = transactions.id AND sl.person_id = p.id))))`);
    args.push(like, like, like, like, like);
  }
  if (q.cursor) {
    const [d, id] = decodeCursor(q.cursor);
    where.push('(date < ? OR (date = ? AND id < ?))');
    args.push(d, d, id);
  }
  const rows = db.prepare(`SELECT ${TXN_COLS} FROM transactions WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`)
    .all(...args, q.limit + 1) as TxnRow[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    transactions: page.map((r) => rowToTransaction(db, r)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.date, last.id) : null,
  };
}

export function assertCategoryExists(db: Db, id: string | null | undefined, field: string): void {
  if (id === null || id === undefined) return;
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) {
    throw new ApiError(400, 'INVALID_REQUEST', `${field}: unknown category`, field);
  }
}

const NEGATIVE_TYPES = new Set(['credit', 'loan']);

/** Categorizing a bank row teaches its Plaid category: later syncs and imports use the mapping, and
 *  uncategorized unsplit bank rows with the same Plaid category take it now. Owner-set categories are never overwritten. */
export function learnCategory(db: Db, transactionId: string, categoryId: string, nowIso: string): void {
  const row = db.prepare("SELECT plaid_category FROM transactions WHERE id = ? AND source IN ('plaid', 'applecard')").get(transactionId) as
    { plaid_category: string | null } | undefined;
  // Transfers, income and card payments stay out of spending only while uncategorized; one odd edit must not pull them all in.
  if (!row?.plaid_category || /^(INCOME|TRANSFER_IN|TRANSFER_OUT)/.test(row.plaid_category)) return;
  // a card payment may teach a transfer category: that keeps every card payment out of spending
  if (row.plaid_category === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    && !db.prepare('SELECT 1 FROM categories WHERE id = ? AND is_transfer = 1').get(categoryId)) return;
  if (db.prepare('SELECT 1 FROM split_lines WHERE transaction_id = ?').get(transactionId)) return;
  db.prepare('INSERT INTO plaid_category_map (plaid_category, category_id) VALUES (?, ?) ON CONFLICT (plaid_category) DO UPDATE SET category_id = excluded.category_id')
    .run(row.plaid_category, categoryId);
  db.prepare(`UPDATE transactions SET category_id = ?, updated_at = ?
     WHERE source IN ('plaid', 'applecard') AND plaid_category = ? AND category_id IS NULL AND category_owner_set = 0 AND removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = transactions.id)`)
    .run(categoryId, nowIso, row.plaid_category);
}

/**
 * Keeps a split adding up after the bank changes the amount (a pending row posting with a tip, a correction). Every line keeps its
 * share of the new amount, so a tip is split the way the bill was; leftover cents go to the largest remainders, and a line that
 * rounds to zero goes. Fewer than two lines left, or a sign flip, ends the split: the transaction takes the category or person of
 * the largest remaining line.
 */
export function fitSplitToAmount(db: Db, transactionId: string, nowIso: string): void {
  const txn = db.prepare('SELECT amount_cents AS a FROM transactions WHERE id = ?').get(transactionId) as { a: number } | undefined;
  const lines = db.prepare('SELECT id, amount_cents AS a, category_id AS c, person_id AS p FROM split_lines WHERE transaction_id = ? ORDER BY id')
    .all(transactionId) as { id: string; a: number; c: string | null; p: string | null }[];
  if (!txn || !lines.length) return;
  const total = lines.reduce((s, l) => s + l.a, 0);
  if (txn.a === total) return;
  const sign = Math.sign(txn.a);
  const sameSign = sign !== 0 && lines.every((l) => Math.sign(l.a) === sign);
  if (sameSign) {
    const t = Math.abs(txn.a);
    const was = Math.abs(total);
    const shares = lines.map((l) => ({ l, cents: Math.floor((Math.abs(l.a) * t) / was), rem: (Math.abs(l.a) * t) % was }));
    let left = t - shares.reduce((s, x) => s + x.cents, 0);
    // sort is stable, so equal remainders get a cent in entry order
    for (const x of [...shares].sort((a, b) => b.rem - a.rem)) {
      if (left-- <= 0) break;
      x.cents += 1;
    }
    for (const x of shares) x.l.a = sign * x.cents;
  }
  const bySize = [...lines].sort((x, y) => Math.abs(y.a) - Math.abs(x.a));
  const kept = bySize.filter((l) => l.a !== 0);
  if (!sameSign || kept.length < 2) {
    db.prepare('DELETE FROM split_lines WHERE transaction_id = ?').run(transactionId);
    const winner = kept[0] ?? bySize[0]!;
    db.prepare('UPDATE transactions SET category_id = ?, person_id = ?, updated_at = ? WHERE id = ?').run(winner.c, winner.p, nowIso, transactionId);
    return;
  }
  const update = db.prepare('UPDATE split_lines SET amount_cents = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM split_lines WHERE id = ?');
  for (const l of lines) if (l.a === 0) remove.run(l.id); else update.run(l.a, l.id);
  db.prepare('UPDATE transactions SET updated_at = ? WHERE id = ?').run(nowIso, transactionId);
}

export function periodRange(q: SpendingQuery): { from: string; toExclusive: string } {
  if (q.period === 'year') {
    return { from: `${q.date}-01-01`, toExclusive: `${String(Number(q.date) + 1).padStart(4, '0')}-01-01` };
  }
  const [ys, ms] = q.date.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const next = m === 12 ? `${String(y + 1).padStart(4, '0')}-01` : `${ys}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${q.date}-01`, toExclusive: `${next}-01` };
}

export function getHome(db: Db): Omit<Home, 'owedToYouCents' | 'youOweCents' | 'repaymentSuggestions'> {
  const accounts = db.prepare('SELECT type, balance_current_cents AS b FROM accounts WHERE hidden = 0 AND balance_current_cents IS NOT NULL').all() as { type: string; b: number }[];
  const netWorthCents = accounts.reduce((sum, a) => sum + (NEGATIVE_TYPES.has(a.type) ? -a.b : a.b), 0);
  const recent = listTransactions(db, { limit: 10 }).transactions;
  const reconnect = (db.prepare("SELECT id, institution_name FROM items WHERE status = 'login_required' ORDER BY institution_name").all() as { id: string; institution_name: string }[])
    .map((i) => ({ itemId: i.id, institutionName: i.institution_name }));
  return { netWorthCents, recent, reconnect };
}

export function getSpending(db: Db, q: SpendingQuery): Spending {
  const { from, toExclusive } = periodRange(q);
  const rows = db.prepare(`
    WITH lines AS (
      SELECT sl.category_id AS category_id, sl.amount_cents AS amount, t.plaid_category AS plaid_category, 0 AS drift
        FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
       WHERE t.removed_at IS NULL AND t.date >= ? AND t.date < ? AND sl.person_id IS NULL
      UNION ALL
      SELECT t.category_id, t.amount_cents, t.plaid_category, 0
        FROM transactions t
       WHERE t.removed_at IS NULL AND t.date >= ? AND t.date < ?
         AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
         AND t.person_id IS NULL
      UNION ALL
      -- the bank changed a split transaction's amount: the owner's lines stay as saved and the exact difference
      -- counts as uncategorized spending until they re-split, so the total always matches the bank
      SELECT NULL, t.amount_cents - SUM(sl.amount_cents), t.plaid_category, 1
        FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
       WHERE t.removed_at IS NULL AND t.date >= ? AND t.date < ?
       GROUP BY t.id HAVING t.amount_cents != SUM(sl.amount_cents)
    )
    SELECT lines.category_id AS categoryId, COALESCE(c.name, 'Uncategorized') AS name, -SUM(lines.amount) AS spentCents
      FROM lines LEFT JOIN categories c ON c.id = lines.category_id
     WHERE (lines.category_id IS NOT NULL AND c.is_transfer = 0 AND c.is_income = 0)
        -- uncategorized: never income, transfers or card payments by Plaid's category; inflows only net
        -- when the bank categorized them (refunds), so manual/unknown inflows don't offset spending
        -- (a split's drift always nets, so a smaller bank amount lowers spending, but keeps the Plaid exclusions)
        OR (lines.category_id IS NULL AND (lines.drift = 1 OR lines.amount < 0 OR lines.plaid_category IS NOT NULL) AND (lines.plaid_category IS NULL OR NOT (
              lines.plaid_category GLOB 'INCOME*' OR lines.plaid_category GLOB 'TRANSFER_IN*'
              OR lines.plaid_category GLOB 'TRANSFER_OUT*' OR lines.plaid_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')))
     GROUP BY lines.category_id
    HAVING spentCents != 0
     ORDER BY spentCents DESC, name`).all(from, toExclusive, from, toExclusive, from, toExclusive) as { categoryId: string | null; name: string; spentCents: number }[];
  return { from, toExclusive, totalCents: rows.reduce((s, r) => s + r.spentCents, 0), categories: rows };
}
