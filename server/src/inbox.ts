import type { InboxList, InboxReceipt, Itemization, LinkedReceipt, SaveItemsBody, Transaction } from '@hermes/shared';
import type { Db } from './db.ts';
import type { Deps } from './deps.ts';
import { ApiError } from './errors.ts';
import { applyItems, computeShares, ME, replaceItems, ShareError } from './itemize.ts';
import { getTransaction } from './ledger.ts';
import { assertPersonTaggable } from './people.ts';
import type { ReadResult } from './receipt-reader.ts';

export type InboxRow = {
  id: string; jpeg: Buffer | null; bytes: number; captured_at: string; read_at: string | null; read_failed: number; model: string | null;
  merchant: string | null; purchase_date: string | null; total_cents: number | null; tax_cents: number | null; tip_cents: number | null;
  fees_cents: number | null; items: string | null; tagged: number; linked_transaction_id: string | null; linked_at: string | null;
  split_applied: number; dismissed_at: string | null;
};
type Item = { name: string; amountCents: number; people: string[] };

export const getInboxRow = (db: Db, id: string) => db.prepare('SELECT * FROM inbox_receipts WHERE id = ?').get(id) as InboxRow | undefined;
const waitingRow = (db: Db, id: string) => {
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
const words = (s: string | null) => new Set((s ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []);

function candidates(db: Db, row: InboxRow): { exact: Transaction[]; near: Transaction[] } {
  if (row.total_cents === null || row.total_cents <= 0) return { exact: [], near: [] };
  const day = row.purchase_date ?? row.captured_at.slice(0, 10);
  const ids = (db.prepare(`SELECT t.id FROM transactions t
      WHERE t.amount_cents < 0 AND t.removed_at IS NULL AND t.paid_by_person_id IS NULL AND t.date BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
      ORDER BY t.date DESC, t.created_at DESC, t.id DESC`).all(addDays(day, -1), addDays(day, 5)) as { id: string }[]).map((r) => r.id);
  const txns = ids.map((id) => getTransaction(db, id)!);
  const total = row.total_cents;
  const store = words(row.merchant);
  const exact = txns.filter((t) => -t.amountCents === total);
  const near = txns.filter((t) => -t.amountCents > total && -t.amountCents <= Math.floor(total * 1.3)
    && [t.payee, t.merchantName, t.bankDescription].some((s) => [...words(s)].some((w) => store.has(w))));
  return { exact, near };
}

export function suggestionsFor(db: Db, row: InboxRow): Transaction[] {
  const { exact, near } = candidates(db, row);
  return [...exact, ...near].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
}

/** Links every waiting receipt with exactly one exact charge that no other waiting receipt also matches exactly. */
export function matchInbox(deps: Deps, onlyId?: string): number {
  const { db } = deps;
  const rows = db.prepare('SELECT * FROM inbox_receipts WHERE linked_at IS NULL AND jpeg IS NOT NULL AND total_cents IS NOT NULL').all() as InboxRow[];
  const exact = new Map(rows.map((r) => [r.id, candidates(db, r).exact.map((t) => t.id)]));
  const claims = new Map<string, number>();
  for (const ids of exact.values()) for (const id of ids) claims.set(id, (claims.get(id) ?? 0) + 1);
  let linked = 0;
  for (const r of rows) {
    if (onlyId && r.id !== onlyId) continue;
    const ids = exact.get(r.id)!;
    if (ids.length === 1 && claims.get(ids[0]!) === 1) { linkInbox(deps, r.id, ids[0]!); linked += 1; }
  }
  return linked;
}

export function linkInbox(deps: Deps, inboxId: string, transactionId: string): LinkedReceipt {
  const { db } = deps;
  return db.transaction(() => {
    const row = waitingRow(db, inboxId);
    if (!row || !row.jpeg) throw new ApiError(404, 'NOT_FOUND', 'inbox receipt not found');
    const txn = getTransaction(db, transactionId);
    if (!txn || db.prepare('SELECT removed_at FROM transactions WHERE id = ?').pluck().get(transactionId) !== null) {
      throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
    }
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

const status = (r: InboxRow): InboxReceipt['status'] => (r.read_failed ? 'failed' : r.read_at === null && !r.tagged ? 'reading' : 'read');

export function listInbox(db: Db): InboxList {
  const waiting = db.prepare('SELECT * FROM inbox_receipts WHERE linked_at IS NULL ORDER BY captured_at DESC, id').all() as InboxRow[];
  const linked = db.prepare(`SELECT * FROM inbox_receipts WHERE linked_at IS NOT NULL AND dismissed_at IS NULL AND linked_transaction_id IS NOT NULL
    ORDER BY linked_at DESC, id LIMIT 20`).all() as InboxRow[];
  return {
    waiting: waiting.map((r) => ({
      id: r.id, capturedAt: r.captured_at, status: status(r), merchant: r.merchant, purchaseDate: r.purchase_date, totalCents: r.total_cents,
      tagged: r.tagged === 1, suggestions: suggestionsFor(db, r),
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
