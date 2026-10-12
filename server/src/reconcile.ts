import type { Reconcile, ReconcileMonths, Transaction } from '@hermes/shared';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { getTransaction, periodRange, rowToTransaction, TXN_COLS, type TxnRow } from './ledger.ts';

// Money out the owner should look at once a month. Over alias `t` (transactions).
export const NEEDS_RECONCILE = `(
  t.removed_at IS NULL AND t.pending = 0 AND t.amount_cents < 0 AND t.paid_by_person_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'investment')
  AND (CASE
    WHEN EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
      THEN EXISTS (SELECT 1 FROM split_lines sl LEFT JOIN categories c ON c.id = sl.category_id
                    WHERE sl.transaction_id = t.id AND (c.id IS NULL OR (c.is_transfer = 0 AND c.is_income = 0)))
    -- paying a person (a roommate) is money that left: it counts whatever Plaid called it
    WHEN t.person_id IS NOT NULL THEN 1
    WHEN t.category_id IS NOT NULL
      THEN EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category_id AND c.is_transfer = 0 AND c.is_income = 0)
    ELSE t.plaid_category IS NULL OR NOT (t.plaid_category GLOB 'INCOME*' OR t.plaid_category GLOB 'TRANSFER_IN*'
      OR t.plaid_category GLOB 'TRANSFER_OUT*' OR t.plaid_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
  END))`;

// marked, and the bank hasn't changed the amount since
export const OPEN = '(t.reconciled_at IS NULL OR t.reconciled_cents != t.amount_cents)';

export function getReconcile(db: Db, month: string): Reconcile {
  const { from, toExclusive } = periodRange({ period: 'month', date: month });
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE t.date >= ? AND t.date < ? AND ${NEEDS_RECONCILE}`)
    .get(from, toExclusive) as { n: number };
  const rows = db.prepare(`SELECT ${TXN_COLS} FROM transactions t WHERE t.date >= ? AND t.date < ? AND ${NEEDS_RECONCILE} AND ${OPEN}
    ORDER BY t.date, t.created_at, t.rowid`).all(from, toExclusive) as TxnRow[];
  return { month, total: n, open: rows.length, transactions: rows.map((r) => rowToTransaction(db, r)) };
}

export function reconcileMonths(db: Db): ReconcileMonths {
  const months = db.prepare(`SELECT substr(t.date, 1, 7) AS month, COUNT(*) AS open FROM transactions t WHERE ${NEEDS_RECONCILE} AND ${OPEN}
    GROUP BY month ORDER BY month`).all() as { month: string; open: number }[];
  return { months };
}

/** The oldest finished month (before `month`) with open rows: what Home's card shows. The current month never nags. */
export function oldestOpenBefore(db: Db, month: string): { month: string; open: number } | null {
  return reconcileMonths(db).months.find((m) => m.month < month) ?? null;
}

export function setReconciled(db: Db, id: string, reconciled: boolean, nowIso: string, amountCents?: number): Transaction {
  // the amount check sits in the UPDATE so check and write are one step
  const changes = !reconciled
    ? db.prepare('UPDATE transactions SET reconciled_at = NULL, reconciled_cents = NULL WHERE id = ? AND removed_at IS NULL').run(id).changes
    : amountCents === undefined
      ? db.prepare('UPDATE transactions SET reconciled_at = ?, reconciled_cents = amount_cents WHERE id = ? AND removed_at IS NULL').run(nowIso, id).changes
      : db.prepare('UPDATE transactions SET reconciled_at = ?, reconciled_cents = amount_cents WHERE id = ? AND removed_at IS NULL AND amount_cents = ?')
        .run(nowIso, id, amountCents).changes;
  if (changes === 0) {
    if (reconciled && amountCents !== undefined && getTransaction(db, id)) throw new ApiError(409, 'AMOUNT_CHANGED', 'the amount changed since you looked');
    throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
  }
  return getTransaction(db, id)!;
}
