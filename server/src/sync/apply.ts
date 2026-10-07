import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { PlaidAccount, PlaidTxn, SyncPage } from '../plaid/port.ts';
import { plaidAmountToCents } from '../money.ts';

export type ApplyCounts = { added: number; modified: number; removed: number };

export function getCutoverDate(db: Db): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cutover_date'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

const toCents = (n: number | null): number | null => (n === null ? null : Math.round(n * 100));

export function upsertAccounts(db: Db, itemId: string, accounts: PlaidAccount[], nowIso: string): void {
  const stmt = db.prepare(`
    INSERT INTO accounts (id, item_id, plaid_account_id, name, mask, type, subtype, balance_current_cents, balance_available_cents, balance_at)
    VALUES (@id, @itemId, @plaidAccountId, @name, @mask, @type, @subtype, @cur, @avail, @at)
    ON CONFLICT (plaid_account_id) DO UPDATE SET
      item_id = excluded.item_id, name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
      balance_current_cents = excluded.balance_current_cents, balance_available_cents = excluded.balance_available_cents,
      balance_at = excluded.balance_at`);
  for (const a of accounts) {
    stmt.run({ id: randomUUID(), itemId, plaidAccountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
      cur: toCents(a.currentBalance), avail: toCents(a.availableBalance), at: nowIso });
  }
}

export function applyPages(db: Db, pages: SyncPage[], opts: { cutoverDate: string | null; nowIso: string }): ApplyCounts {
  const accountIds = new Map<string, string>();
  const accountFor = (plaidAccountId: string): string => {
    let id = accountIds.get(plaidAccountId);
    if (!id) {
      const row = db.prepare('SELECT id FROM accounts WHERE plaid_account_id = ?').get(plaidAccountId) as { id: string } | undefined;
      if (!row) throw new Error('unknown plaid account');
      id = row.id;
      accountIds.set(plaidAccountId, id);
    }
    return id;
  };
  const mappedCategory = db.prepare('SELECT category_id FROM plaid_category_map WHERE plaid_category = ?');
  const checkSuperseded = db.prepare("SELECT id FROM transactions WHERE source = 'plaid' AND pending_source_id = ?");
  const getRow = db.prepare("SELECT id, category_id, payee, notes FROM transactions WHERE source = 'plaid' AND source_id = ?");
  const upsert = db.prepare(`
    INSERT INTO transactions (id, account_id, source, source_id, date, authorized_date, amount_cents, bank_description, merchant_name,
      plaid_category, pending, pending_source_id, category_id, payee, notes, created_at, updated_at)
    VALUES (@id, @accountId, 'plaid', @sourceId, @date, @authorizedDate, @amount, @desc, @merchant, @plaidCategory, @pending,
      @pendingSourceId, @categoryId, @payee, @notes, @now, @now)
    ON CONFLICT (source, source_id) DO UPDATE SET
      account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date,
      amount_cents = excluded.amount_cents, bank_description = excluded.bank_description, merchant_name = excluded.merchant_name,
      plaid_category = excluded.plaid_category, pending = excluded.pending, pending_source_id = excluded.pending_source_id,
      removed_at = NULL, updated_at = excluded.updated_at`);
  const markRemoved = db.prepare("UPDATE transactions SET removed_at = ?, updated_at = ? WHERE source = 'plaid' AND source_id = ? AND removed_at IS NULL");

  const counts: ApplyCounts = { added: 0, modified: 0, removed: 0 };
  const write = (t: PlaidTxn): boolean => {
    if (opts.cutoverDate && t.date < opts.cutoverDate) return false;
    // If this is a pending row that is superseded by a posted row, don't insert/update it
    if (t.pending) {
      const superseded = checkSuperseded.get(t.transactionId) as { id: string } | undefined;
      if (superseded) {
        if (getRow.get(t.transactionId)) markRemoved.run(opts.nowIso, opts.nowIso, t.transactionId);
        return false;
      }
    }
    const mapped = t.category ? (mappedCategory.get(t.category) as { category_id: string } | undefined) : undefined;
    // Check if row exists
    const exists = getRow.get(t.transactionId) as { id: string } | undefined;
    // When inserting new row with a pending predecessor, carry over owner fields
    let categoryId = mapped?.category_id ?? null;
    let payee: string | null = null;
    let notes: string | null = null;
    if (!exists && t.pendingTransactionId) {
      const pending = getRow.get(t.pendingTransactionId) as { category_id: string | null; payee: string | null; notes: string | null } | undefined;
      if (pending) {
        categoryId = pending.category_id !== null ? pending.category_id : mapped?.category_id ?? null;
        payee = pending.payee;
        notes = pending.notes;
      }
    }
    upsert.run({
      id: randomUUID(), accountId: accountFor(t.accountId), sourceId: t.transactionId, date: t.date, authorizedDate: t.authorizedDate,
      amount: plaidAmountToCents(t.amount), desc: t.name, merchant: t.merchantName, plaidCategory: t.category,
      pending: t.pending ? 1 : 0, pendingSourceId: t.pendingTransactionId, categoryId, payee, notes, now: opts.nowIso,
    });
    if (t.pendingTransactionId) {
      markRemoved.run(opts.nowIso, opts.nowIso, t.pendingTransactionId);
    }
    return true;
  };

  for (const p of pages) {
    for (const t of p.added) if (write(t)) counts.added += 1;
    for (const t of p.modified) if (write(t)) counts.modified += 1;
    for (const r of p.removed) counts.removed += markRemoved.run(opts.nowIso, opts.nowIso, r.transactionId).changes;
  }
  return counts;
}
