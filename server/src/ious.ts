import type { Db } from './db.ts';

// Every live amount between the owner and a person: split lines and unsplit transactions tagged with them, and manual rows they paid.
// Money out (negative) raises what they owe; money in, and a row they paid (its share counted as positive), lowers it.
export const TAGGED = `
  SELECT sl.person_id AS person_id, t.id AS transaction_id, sl.id AS line_id, t.date AS date,
         COALESCE(sl.payee, t.payee, t.merchant_name, t.bank_description) AS payee, sl.amount_cents AS amount, 0 AS paid_by,
         t.created_at AS created_at, t.rowid AS row_order, t.forgiven AS forgiven
    FROM split_lines sl JOIN transactions t ON t.id = sl.transaction_id
   WHERE sl.person_id IS NOT NULL AND t.removed_at IS NULL
  UNION ALL
  SELECT t.person_id, t.id, NULL, t.date, COALESCE(t.payee, t.merchant_name, t.bank_description), t.amount_cents, 0, t.created_at, t.rowid, t.forgiven
    FROM transactions t
   WHERE t.person_id IS NOT NULL AND t.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
  UNION ALL
  SELECT t.paid_by_person_id, t.id, NULL, t.date, COALESCE(t.payee, t.merchant_name, t.bank_description), -t.amount_cents, 1, t.created_at, t.rowid, t.forgiven
    FROM transactions t
   WHERE t.paid_by_person_id IS NOT NULL AND t.removed_at IS NULL AND t.source = 'manual' AND t.amount_cents < 0`;

export type Tagged = { person_id: string; transaction_id: string; line_id: string | null; date: string; payee: string; amount: number; paid_by: number; created_at: string; row_order: number; forgiven: number };
export type Link = { id: string; payback_transaction_id: string; payback_line_id: string | null; item_transaction_id: string; item_line_id: string | null; amount_cents: number; created_at: string };
export type ItemState = { entry: Tagged; leftCents: number; paybacks: { transactionId: string; lineId: string | null; date: string; amountCents: number }[] };
export type Settled = { items: Map<string, ItemState>; paidBack: Map<string, { transactionId: string; lineId: string | null; amountCents: number }[]> };

export const entryKey = (txn: string, line: string | null): string => `${txn}|${line ?? ''}`;
const isItem = (t: Tagged) => t.amount < 0 && !t.paid_by && !t.forgiven;
const isPayback = (t: Tagged) => t.amount > 0 && !t.paid_by && !t.forgiven;

/** One person's open items, computed on every read like the balance: links first (capped by what each side has left),
 * then every credit's unapplied money settles the oldest open items. Sum of leftCents = max(balance, 0). */
export function settle(entries: Tagged[], links: Link[]): Settled {
  const items = new Map<string, ItemState>();
  for (const t of entries) if (isItem(t)) items.set(entryKey(t.transaction_id, t.line_id), { entry: t, leftCents: -t.amount, paybacks: [] });
  const credit = new Map(entries.filter((t) => t.amount > 0).map((t) => [entryKey(t.transaction_id, t.line_id), t.amount]));
  const byPayback = Map.groupBy([...links].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    (k) => entryKey(k.payback_transaction_id, k.payback_line_id));
  const paidBack: Settled['paidBack'] = new Map();
  for (const p of entries.filter(isPayback)) {
    const pk = entryKey(p.transaction_id, p.line_id);
    for (const k of byPayback.get(pk) ?? []) {
      const item = items.get(entryKey(k.item_transaction_id, k.item_line_id));
      const cents = Math.min(k.amount_cents, credit.get(pk)!, item?.leftCents ?? 0);
      if (!item || cents <= 0) continue;
      item.leftCents -= cents;
      credit.set(pk, credit.get(pk)! - cents);
      item.paybacks.push({ transactionId: p.transaction_id, lineId: p.line_id, date: p.date, amountCents: cents });
      paidBack.set(pk, [...(paidBack.get(pk) ?? []), { transactionId: item.entry.transaction_id, lineId: item.entry.line_id, amountCents: cents }]);
    }
  }
  const open = [...items.values()];
  for (const t of entries) {
    let rest = credit.get(entryKey(t.transaction_id, t.line_id)) ?? 0;
    for (const item of open) {
      if (rest <= 0) break;
      const cents = Math.min(rest, item.leftCents);
      item.leftCents -= cents;
      rest -= cents;
    }
  }
  return { items, paidBack };
}

/** Same order as the person feed: date, then the order they were recorded. */
export function personEntries(db: Db, personId: string): Tagged[] {
  return db.prepare(`SELECT * FROM (${TAGGED}) WHERE person_id = ? ORDER BY date, created_at, row_order, line_id`).all(personId) as Tagged[];
}

export function personLinks(db: Db, entries: Tagged[]): Link[] {
  const ids = JSON.stringify([...new Set(entries.map((t) => t.transaction_id))]);
  return db.prepare('SELECT * FROM iou_links WHERE payback_transaction_id IN (SELECT value FROM json_each(?))').all(ids) as Link[];
}

/** without: an entryKey settled as if it weren't in the ledger (the payback being edited). */
export function settlePerson(db: Db, personId: string, without?: string): Settled {
  const entries = personEntries(db, personId).filter((t) => entryKey(t.transaction_id, t.line_id) !== without);
  return settle(entries, personLinks(db, entries));
}
