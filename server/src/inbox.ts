import type { InboxList, InboxReceipt, Itemization, LinkedReceipt, SaveItemsBody, Transaction } from '@hermes/shared';
import type { Db } from './db.ts';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';
import { applyItems, computeShares, ME, replaceItems, ShareError } from './itemize.ts';
import { getTransaction, lookups, rowToTransaction, TXN_COLS, type TxnRow } from './ledger.ts';
import { assertPersonTaggable } from './people.ts';
import type { ReadResult } from './receipt-reader.ts';
import { normalizeName } from './recurring.ts';

export type InboxRow = {
  id: string; jpeg: Buffer | null; bytes: number; captured_at: string; read_at: string | null; read_failed: number; model: string | null;
  merchant: string | null; purchase_date: string | null; total_cents: number | null; tax_cents: number | null; tip_cents: number | null;
  fees_cents: number | null; items: string | null; tagged: number; linked_transaction_id: string | null; linked_at: string | null;
  split_applied: number; dismissed_at: string | null;
};
type Item = { name: string; amountCents: number; people: string[] };

export const getInboxRow = (db: Db, id: string) => db.prepare('SELECT * FROM inbox_receipts WHERE id = ?').get(id) as InboxRow | undefined;
export const waitingRow = (db: Db, id: string) => {
  const row = getInboxRow(db, id);
  return row && row.linked_at === null ? row : undefined;
};
const itemsOf = (row: InboxRow): Item[] => (row.items ? JSON.parse(row.items) as Item[] : []);

export function storeRead(db: Db, id: string, r: ReadResult, nowIso: string): boolean {
  return db.prepare(`UPDATE inbox_receipts SET read_at = ?, read_failed = 0, model = ?, merchant = ?, purchase_date = ?, total_cents = ?,
      tax_cents = ?, tip_cents = ?, fees_cents = ?, items = ?, tagged = 0 WHERE id = ? AND linked_at IS NULL AND jpeg IS NOT NULL`)
    .run(nowIso, r.model, r.merchant, r.purchaseDate, r.totalCents, r.taxCents, r.tipCents, r.feesCents,
      JSON.stringify(r.items.map((i) => ({ ...i, people: [ME] }))), id).changes > 0;
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const STOP = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'corp', 'company', 'store', 'shop', 'www', 'com']);
const words = (s: string | null) => new Set((s ?? '').toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
const sharesWord = (t: Transaction, store: Set<string>) => [t.payee, t.merchantName, t.bankDescription].some((s) => [...words(s)].some((w) => store.has(w)));

function candidates(db: Db, row: InboxRow): { exact: Transaction[]; near: Transaction[] } {
  if (row.total_cents === null || row.total_cents <= 0) return { exact: [], near: [] };
  const day = row.purchase_date ?? row.captured_at.slice(0, 10);
  const rows = db.prepare(`SELECT ${TXN_COLS} FROM transactions t
      WHERE t.amount_cents < 0 AND t.removed_at IS NULL AND t.paid_by_person_id IS NULL AND t.date BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
      ORDER BY t.date DESC, t.created_at DESC, t.id DESC`).all(addDays(day, -1), addDays(day, 5)) as TxnRow[];
  const l = lookups(db, rows);
  const txns = rows.map((r) => rowToTransaction(db, r, l));
  const total = row.total_cents;
  const store = words(row.merchant);
  const exact = txns.filter((t) => -t.amountCents === total);
  const near = txns.filter((t) => -t.amountCents > total && -t.amountCents <= Math.floor(total * 1.3) && sharesWord(t, store));
  return { exact, near };
}

export function suggestionsFor(db: Db, row: InboxRow): Transaction[] {
  const { exact, near } = candidates(db, row);
  return [...exact, ...near].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
}

/** Puts a linked receipt's photo back in the inbox before its transaction loses it; items and tags stay on the inbox row. */
export function restoreToInbox(db: Db, txnId: string): void {
  db.prepare(`UPDATE inbox_receipts SET jpeg = (SELECT jpeg FROM receipts WHERE transaction_id = ?), linked_transaction_id = NULL, linked_at = NULL,
      split_applied = 0, dismissed_at = NULL WHERE linked_transaction_id = ? AND EXISTS (SELECT 1 FROM receipts WHERE transaction_id = ?)`).run(txnId, txnId, txnId);
}

/** A restart mid-read would otherwise show "Reading…" forever. */
export function markInterruptedReads(db: Db): void {
  db.prepare('UPDATE inbox_receipts SET read_failed = 1 WHERE read_at IS NULL AND read_failed = 0 AND tagged = 0 AND linked_at IS NULL').run();
}

/** Links every waiting receipt with exactly one exact charge from its store that no other waiting receipt also matches exactly. */
export function matchInbox(deps: Deps, onlyId?: string): number {
  const { db } = deps;
  // a removed charge (say, a pending one with no posted row) gives its receipt back to the inbox
  const gone = db.prepare(`SELECT t.id FROM inbox_receipts i JOIN transactions t ON t.id = i.linked_transaction_id
    WHERE t.removed_at IS NOT NULL`).pluck().all() as string[];
  for (const id of gone) {
    db.transaction(() => {
      restoreToInbox(db, id);
      db.prepare('DELETE FROM receipts WHERE transaction_id = ?').run(id);
      db.prepare('DELETE FROM receipt_items WHERE transaction_id = ?').run(id);
    })();
  }
  const rows = db.prepare('SELECT * FROM inbox_receipts WHERE linked_at IS NULL AND jpeg IS NOT NULL AND total_cents IS NOT NULL').all() as InboxRow[];
  const exact = new Map(rows.map((r) => [r.id, candidates(db, r).exact]));
  const claims = new Map<string, number>();
  for (const ts of exact.values()) for (const t of ts) claims.set(t.id, (claims.get(t.id) ?? 0) + 1);
  let linked = 0;
  for (const r of rows) {
    if (onlyId && r.id !== onlyId) continue;
    const store = words(r.merchant);
    const sure = exact.get(r.id)!.filter((t) => sharesWord(t, store));
    if (sure.length !== 1 || claims.get(sure[0]!.id) !== 1) continue;
    try {
      linkInbox(deps, r.id, sure[0]!.id);
      linked += 1;
    } catch (e) {
      console.error(`[hermes] inbox link failed code=${e instanceof ApiError ? e.code : 'UNKNOWN'}`);
    }
  }
  return linked;
}

export function linkInbox(deps: Deps, inboxId: string, transactionId: string): LinkedReceipt {
  const { db } = deps;
  return db.transaction(() => {
    const row = waitingRow(db, inboxId);
    if (!row || !row.jpeg) throw new ApiError(404, 'NOT_FOUND', 'inbox receipt not found');
    const txn = getTransaction(db, transactionId);
    if (!txn) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
    if (txn.amountCents >= 0) throw new ApiError(409, 'NOT_MONEY_OUT', 'only money out can have a receipt from the inbox');
    if (txn.hasReceipt) throw new ApiError(409, 'HAS_RECEIPT', 'this transaction already has a receipt');
    const now = deps.now().toISOString();
    db.prepare(`INSERT INTO receipts (transaction_id, jpeg, bytes, created_at, tax_cents, tip_cents, fees_cents, total_cents, read_at, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(transactionId, row.jpeg, row.bytes, now, row.tax_cents, row.tip_cents, row.fees_cents, row.total_cents, row.read_at, row.model);
    const items = itemsOf(row);
    let applied = false;
    if (row.tagged && items.length && txn.splitLines.length === 0 && txn.personId === null) {
      try {
        // a savepoint: a rejected apply undoes only itself, and the link still happens
        db.transaction(() => applyItems(db, transactionId,
          { items, taxCents: row.tax_cents ?? 0, tipCents: row.tip_cents ?? 0, feesCents: row.fees_cents ?? 0 }, now))();
        applied = true;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
      }
    }
    if (!applied) {
      const defaults = txn.paidByPersonId ? [ME, txn.paidByPersonId] : [ME];
      replaceItems(db, transactionId, row.tagged ? items : items.map((i) => ({ ...i, people: defaults })));
    }
    db.prepare('UPDATE inbox_receipts SET jpeg = NULL, linked_transaction_id = ?, linked_at = ?, split_applied = ? WHERE id = ?')
      .run(transactionId, now, applied ? 1 : 0, inboxId);
    return toLinked(getInboxRow(db, inboxId)!);
  })();
}

const toLinked = (r: InboxRow): LinkedReceipt => ({
  id: r.id, transactionId: r.linked_transaction_id!, merchant: r.merchant, totalCents: r.total_cents, linkedAt: r.linked_at!, splitApplied: r.split_applied === 1,
});

const status = (r: InboxRow): InboxReceipt['status'] => (r.tagged ? 'read' : r.read_failed ? 'failed' : r.read_at === null ? 'reading' : 'read');

/** The payee name already in use for this store: the most specific one whose words start the receipt's ("Acme" for "Acme Wholesale"),
 * the most used on a tie, then alphabetical; else the receipt's own merchant. */
// ponytail: scans every distinct payee per receipt, fine for a personal ledger
function payeeFor(known: { payee: string; n: number }[], merchant: string | null): string | null {
  if (!merchant) return null;
  const key = `${normalizeName(merchant)} `;
  const best = known.map((k) => ({ ...k, key: normalizeName(k.payee) }))
    .filter((k) => k.key && key.startsWith(`${k.key} `))
    .sort((a, b) => b.key.length - a.key.length || b.n - a.n || a.payee.localeCompare(b.payee))[0];
  return best?.payee ?? merchant;
}

export function listInbox(db: Db): InboxList {
  const waiting = db.prepare('SELECT * FROM inbox_receipts WHERE linked_at IS NULL ORDER BY captured_at DESC, id').all() as InboxRow[];
  // the names shown on charges (a bank row's merchant until renamed); never a person's IOU or Zelle row
  const known = waiting.length ? db.prepare(`SELECT COALESCE(payee, merchant_name) AS payee, COUNT(*) AS n FROM transactions
      WHERE COALESCE(payee, merchant_name) IS NOT NULL AND removed_at IS NULL AND amount_cents < 0 AND person_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = category_id AND (c.is_transfer = 1 OR c.is_income = 1))
      GROUP BY 1`).all() as { payee: string; n: number }[] : [];
  const linked = db.prepare(`SELECT * FROM inbox_receipts WHERE linked_at IS NOT NULL AND dismissed_at IS NULL AND linked_transaction_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM receipts WHERE transaction_id = linked_transaction_id)
    ORDER BY linked_at DESC, id LIMIT 20`).all() as InboxRow[];
  return {
    waiting: waiting.map((r) => ({
      id: r.id, capturedAt: r.captured_at, status: status(r), merchant: r.merchant, purchaseDate: r.purchase_date, totalCents: r.total_cents,
      tagged: r.tagged === 1, payee: payeeFor(known, r.merchant), suggestions: suggestionsFor(db, r),
    })),
    recentlyLinked: linked.map(toLinked),
  };
}

export function inboxItemization(row: InboxRow): Itemization {
  return {
    items: itemsOf(row).map((i, n) => ({ id: `${row.id}-${n}`, ...i })),
    taxCents: row.tax_cents, tipCents: row.tip_cents, feesCents: row.fees_cents, totalCents: row.total_cents, readAt: row.read_at, handEdited: false,
  };
}

/** Tags saved before the charge exists; the target is the receipt itself (items + extras). */
export function saveInboxItems(db: Db, id: string, body: SaveItemsBody): Itemization {
  const row = waitingRow(db, id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'inbox receipt not found');
  body.items.forEach((item, i) => item.people.forEach((p) => {
    if (p !== ME) assertPersonTaggable(db, p, `items.${i}.people`, '');
  }));
  const receipt = body.items.reduce((s, i) => s + i.amountCents, 0) + body.taxCents + body.tipCents + body.feesCents;
  try {
    computeShares({ ...body, targetCents: receipt });
  } catch (e) {
    if (e instanceof ShareError) throw new ApiError(400, 'INVALID_REQUEST', `items: ${e.message}`, 'items');
    throw e;
  }
  db.prepare(`UPDATE inbox_receipts SET items = ?, tax_cents = ?, tip_cents = ?, fees_cents = ?, tagged = 1,
      total_cents = COALESCE(total_cents, ?) WHERE id = ?`)
    .run(JSON.stringify(body.items), body.taxCents, body.tipCents, body.feesCents, receipt, id);
  return inboxItemization(getInboxRow(db, id)!);
}
