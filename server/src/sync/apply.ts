import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { PlaidAccount, PlaidTxn, SyncPage } from '../plaid/port.ts';
import { plaidAmountToCents } from '../money.ts';
import { fillFromMemory, fitSplitToAmount, merchantMemory } from '../ledger.ts';
import { nameZellePayees } from '../zelle.ts';
import { normalizeName } from '../recurring.ts';

type ApplyCounts = { added: number; modified: number; removed: number };

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
  db.prepare(`UPDATE accounts SET balance_current_cents = NULL, balance_available_cents = NULL
    WHERE item_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value = accounts.plaid_account_id)`)
    .run(itemId, JSON.stringify(accounts.map((a) => a.accountId)));
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
  // a receipt added while pending moves to the posted row (unless that row already has one)
  // items follow their receipt; checked before the receipt moves, with the same condition
  const moveItems = db.prepare('UPDATE receipt_items SET transaction_id = ? WHERE transaction_id = ? AND NOT EXISTS (SELECT 1 FROM receipts WHERE transaction_id = ?)');
  const moveReceipt = db.prepare('UPDATE receipts SET transaction_id = ? WHERE transaction_id = ? AND NOT EXISTS (SELECT 1 FROM receipts WHERE transaction_id = ?)');
  const moveInboxLink = db.prepare('UPDATE inbox_receipts SET linked_transaction_id = ? WHERE linked_transaction_id = ?');
  const mappedCategory = db.prepare('SELECT category_id FROM plaid_category_map WHERE plaid_category = ?');
  const remembered = merchantMemory(db);
  const checkSuperseded = db.prepare("SELECT id FROM transactions WHERE source = 'plaid' AND pending_source_id = ?");
  const getRow = db.prepare("SELECT id, date, date_owner_set, category_id, category_owner_set, payee, payee_owner_set, notes, person_id, repayment_dismissed, pending_source_id FROM transactions WHERE source = 'plaid' AND source_id = ?");
  const upsert = db.prepare(`
    INSERT INTO transactions (id, account_id, source, source_id, date, authorized_date, amount_cents, bank_description, merchant_name,
      plaid_category, pending, pending_source_id, category_id, category_owner_set, payee, payee_owner_set, notes, person_id, repayment_dismissed, date_owner_set, created_at, updated_at)
    VALUES (@id, @accountId, 'plaid', @sourceId, @date, @authorizedDate, @amount, @desc, @merchant, @plaidCategory, @pending,
      @pendingSourceId, @categoryId, @ownerSet, @payee, @payeeOwnerSet, @notes, @personId, @dismissed, @dateOwnerSet, @now, @now)
    ON CONFLICT (source, source_id) DO UPDATE SET
      account_id = excluded.account_id, date = CASE WHEN transactions.date_owner_set = 1 THEN transactions.date ELSE excluded.date END, authorized_date = excluded.authorized_date,
      amount_cents = excluded.amount_cents, bank_description = excluded.bank_description, merchant_name = excluded.merchant_name,
      plaid_category = excluded.plaid_category, pending = excluded.pending,
      category_id = COALESCE(transactions.category_id, CASE WHEN transactions.category_owner_set = 0 THEN excluded.category_id END),
      pending_source_id = COALESCE(excluded.pending_source_id, transactions.pending_source_id),
      removed_at = NULL, updated_at = excluded.updated_at`);
  const markRemoved = db.prepare("UPDATE transactions SET removed_at = ?, updated_at = ? WHERE source = 'plaid' AND source_id = ? AND removed_at IS NULL");

  const counts: ApplyCounts = { added: 0, modified: 0, removed: 0 };
  const write = (t: PlaidTxn): boolean => {
    const cutover = cutoverFor(t.accountId);
    if (cutover && t.date < cutover) {
      counts.removed += markRemoved.run(opts.nowIso, opts.nowIso, t.transactionId).changes;
      const pending = t.pendingTransactionId ?? (getRow.get(t.transactionId) as { pending_source_id: string | null } | undefined)?.pending_source_id;
      if (pending) counts.removed += markRemoved.run(opts.nowIso, opts.nowIso, pending).changes;
      return false;
    }
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
    // what the same merchant was categorized as last time comes before the Plaid category's mapping
    const learned = remembered(t.merchantName, t.name)
      ?? (t.category ? (mappedCategory.get(t.category) as { category_id: string } | undefined)?.category_id : undefined) ?? null;
    // Check if row exists
    const exists = getRow.get(t.transactionId) as { id: string } | undefined;
    // When inserting new row with a pending predecessor, carry over owner fields
    let categoryId = learned;
    let ownerSet = 0;
    let payee: string | null = null;
    let payeeOwnerSet = 0;
    let notes: string | null = null;
    let personId: string | null = null;
    let dismissed = 0;
    let date = t.date;
    let dateOwnerSet = 0;
    let pendingId: string | null = null;
    if (!exists && t.pendingTransactionId) {
      const pending = getRow.get(t.pendingTransactionId) as
        { id: string; date: string; date_owner_set: number; category_id: string | null; category_owner_set: number; payee: string | null; payee_owner_set: number;
          notes: string | null; person_id: string | null; repayment_dismissed: number } | undefined;
      if (pending) {
        ownerSet = pending.category_owner_set;
        categoryId = pending.category_id !== null || ownerSet ? pending.category_id : learned;
        payee = pending.payee;
        payeeOwnerSet = pending.payee_owner_set;
        notes = pending.notes;
        personId = pending.person_id;
        dismissed = pending.repayment_dismissed;
        if (pending.date_owner_set) { date = pending.date; dateOwnerSet = 1; }
        pendingId = pending.id;
      }
    }
    upsert.run({
      id: randomUUID(), accountId: accountFor(t.accountId), sourceId: t.transactionId, date, authorizedDate: t.authorizedDate,
      amount: plaidAmountToCents(t.amount), desc: t.name, merchant: t.merchantName, plaidCategory: t.category,
      pending: t.pending ? 1 : 0, pendingSourceId: t.pendingTransactionId, categoryId, ownerSet, payee, payeeOwnerSet, notes, personId, dismissed, dateOwnerSet, now: opts.nowIso,
    });
    if (t.pendingTransactionId) {
      markRemoved.run(opts.nowIso, opts.nowIso, t.pendingTransactionId);
    }
    const id = (getRow.get(t.transactionId) as { id: string }).id;
    // a split made while pending moves to the posted row
    if (pendingId) moveSplit.run(id, pendingId);
    if (pendingId) moveItems.run(id, pendingId, id);
    if (pendingId) moveReceipt.run(id, pendingId, id);
    if (pendingId) moveInboxLink.run(id, pendingId);
    fitSplitToAmount(db, id, opts.nowIso);
    return true;
  };

  for (const p of pages) {
    for (const t of p.added) if (write(t)) counts.added += 1;
    for (const t of p.modified) if (write(t)) counts.modified += 1;
    for (const r of p.removed) counts.removed += markRemoved.run(opts.nowIso, opts.nowIso, r.transactionId).changes;
  }
  // Also repairs bills promoted before this pass existed; owner-renamed match text stays intact.
  const promoted = db.prepare(`SELECT m.id, m.match_text, p.id AS posted_id,
      t.merchant_name AS pending_merchant, t.bank_description AS pending_bank,
      COALESCE(p.merchant_name, p.bank_description) AS posted_name
    FROM recurring_manual m JOIN transactions t ON t.id = m.source_transaction_id AND t.source = 'plaid'
    JOIN transactions p ON p.source = 'plaid' AND p.pending_source_id = t.source_id AND p.pending = 0 AND p.removed_at IS NULL
    JOIN accounts a ON a.id = p.account_id WHERE a.item_id = ?`).all(opts.itemId) as
    { id: string; match_text: string; posted_id: string; pending_merchant: string | null; pending_bank: string; posted_name: string }[];
  const moveBill = db.prepare('UPDATE recurring_manual SET source_transaction_id = ?, match_text = ? WHERE id = ?');
  for (const r of promoted) moveBill.run(r.posted_id, [r.pending_merchant, r.pending_bank].some((n) => n && r.match_text === normalizeName(n))
    ? normalizeName(r.posted_name) || r.match_text : r.match_text, r.id);
  // new rows get their name, and history is backfilled on the first sync after deploy
  nameZellePayees(db, opts.nowIso);
  fillFromMemory(db, opts.nowIso);
  return counts;
}
