import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { PlaidAccount, PlaidTxn, SyncPage } from '../plaid/port.ts';
import { plaidAmountToCents } from '../money.ts';
import { fitSplitToAmount } from '../ledger.ts';

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
      balance_at = excluded.balance_at,
      -- a placeholder from applyPages (never upserted, so no balance_at) becomes visible; owner-hidden accounts stay hidden
      hidden = CASE WHEN accounts.balance_at IS NULL AND accounts.name = 'Unknown account' THEN 0 ELSE accounts.hidden END`);
  for (const a of accounts) {
    stmt.run({ id: randomUUID(), itemId, plaidAccountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
      cur: toCents(a.currentBalance), avail: toCents(a.availableBalance), at: nowIso });
  }
  // rows parked on a placeholder before Plaid said the account is an investment one; sync skips investment rows from here on
  db.prepare(`UPDATE transactions SET removed_at = ?, updated_at = ? WHERE source = 'plaid' AND removed_at IS NULL
    AND account_id IN (SELECT id FROM accounts WHERE item_id = ? AND type = 'investment')`).run(nowIso, nowIso, itemId);
}

export function applyPages(db: Db, pages: SyncPage[], opts: { itemId: string; cutoverDate: string | null; nowIso: string }): ApplyCounts {
  const accountIds = new Map<string, string>();
  const accountFor = (plaidAccountId: string): string => {
    let id = accountIds.get(plaidAccountId);
    if (!id) {
      const row = db.prepare('SELECT id FROM accounts WHERE plaid_account_id = ?').get(plaidAccountId) as { id: string } | undefined;
      id = row?.id ?? randomUUID();
      // Plaid sent a transaction for an account accountsGet didn't list: park it on a hidden placeholder rather than wedge the item
      if (!row) {
        db.prepare("INSERT INTO accounts (id, item_id, plaid_account_id, name, type, hidden) VALUES (?, ?, ?, 'Unknown account', 'other', 1)")
          .run(id, opts.itemId, plaidAccountId);
      }
      accountIds.set(plaidAccountId, id);
    }
    return id;
  };
  const accountCutovers = new Map<string, string | null>();
  const cutoverFor = (plaidAccountId: string): string | null => {
    if (!accountCutovers.has(plaidAccountId)) {
      const row = db.prepare('SELECT cutover_date FROM accounts WHERE plaid_account_id = ?').get(plaidAccountId) as { cutover_date: string | null } | undefined;
      accountCutovers.set(plaidAccountId, row?.cutover_date ?? null);
    }
    return accountCutovers.get(plaidAccountId) ?? opts.cutoverDate;
  };
  const isInvestment = db.prepare("SELECT 1 FROM accounts WHERE plaid_account_id = ? AND type = 'investment'");
  const moveSplit = db.prepare('UPDATE split_lines SET transaction_id = ? WHERE transaction_id = ?');
  const mappedCategory = db.prepare('SELECT category_id FROM plaid_category_map WHERE plaid_category = ?');
  const checkSuperseded = db.prepare("SELECT id FROM transactions WHERE source = 'plaid' AND pending_source_id = ?");
  const getRow = db.prepare("SELECT id, category_id, category_owner_set, payee, notes, person_id FROM transactions WHERE source = 'plaid' AND source_id = ?");
  const upsert = db.prepare(`
    INSERT INTO transactions (id, account_id, source, source_id, date, authorized_date, amount_cents, bank_description, merchant_name,
      plaid_category, pending, pending_source_id, category_id, category_owner_set, payee, notes, person_id, created_at, updated_at)
    VALUES (@id, @accountId, 'plaid', @sourceId, @date, @authorizedDate, @amount, @desc, @merchant, @plaidCategory, @pending,
      @pendingSourceId, @categoryId, @ownerSet, @payee, @notes, @personId, @now, @now)
    ON CONFLICT (source, source_id) DO UPDATE SET
      account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date,
      amount_cents = excluded.amount_cents, bank_description = excluded.bank_description, merchant_name = excluded.merchant_name,
      plaid_category = excluded.plaid_category, pending = excluded.pending,
      category_id = COALESCE(transactions.category_id, CASE WHEN transactions.category_owner_set = 0 THEN excluded.category_id END),
      pending_source_id = COALESCE(excluded.pending_source_id, transactions.pending_source_id),
      removed_at = NULL, updated_at = excluded.updated_at`);
  const markRemoved = db.prepare("UPDATE transactions SET removed_at = ?, updated_at = ? WHERE source = 'plaid' AND source_id = ? AND removed_at IS NULL");

  const counts: ApplyCounts = { added: 0, modified: 0, removed: 0 };
  const write = (t: PlaidTxn): boolean => {
    const cutover = cutoverFor(t.accountId);
    if (cutover && t.date < cutover) return false;
    // investment accounts count toward net worth by balance alone; their buys, sells and dividends aren't spending
    if (isInvestment.get(t.accountId)) return false;
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
    let ownerSet = 0;
    let payee: string | null = null;
    let notes: string | null = null;
    let personId: string | null = null;
    let pendingId: string | null = null;
    if (!exists && t.pendingTransactionId) {
      const pending = getRow.get(t.pendingTransactionId) as
        { id: string; category_id: string | null; category_owner_set: number; payee: string | null; notes: string | null; person_id: string | null } | undefined;
      if (pending) {
        ownerSet = pending.category_owner_set;
        categoryId = pending.category_id !== null || ownerSet ? pending.category_id : mapped?.category_id ?? null;
        payee = pending.payee;
        notes = pending.notes;
        personId = pending.person_id;
        pendingId = pending.id;
      }
    }
    upsert.run({
      id: randomUUID(), accountId: accountFor(t.accountId), sourceId: t.transactionId, date: t.date, authorizedDate: t.authorizedDate,
      amount: plaidAmountToCents(t.amount), desc: t.name, merchant: t.merchantName, plaidCategory: t.category,
      pending: t.pending ? 1 : 0, pendingSourceId: t.pendingTransactionId, categoryId, ownerSet, payee, notes, personId, now: opts.nowIso,
    });
    if (t.pendingTransactionId) {
      markRemoved.run(opts.nowIso, opts.nowIso, t.pendingTransactionId);
    }
    const id = (getRow.get(t.transactionId) as { id: string }).id;
    // a split made while pending moves to the posted row
    if (pendingId) moveSplit.run(id, pendingId);
    fitSplitToAmount(db, id, opts.nowIso);
    return true;
  };

  for (const p of pages) {
    for (const t of p.added) if (write(t)) counts.added += 1;
    for (const t of p.modified) if (write(t)) counts.modified += 1;
    for (const r of p.removed) counts.removed += markRemoved.run(opts.nowIso, opts.nowIso, r.transactionId).changes;
  }
  return counts;
}
