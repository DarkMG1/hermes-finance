import type { OpenItem } from '@hermes/shared';
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

// two links from one payback to one item (lines collapsed by a split rewrite) report as one
const add = <T extends { transactionId: string; lineId: string | null; amountCents: number }>(list: T[], e: T) => {
  const prior = list.find((x) => x.transactionId === e.transactionId && x.lineId === e.lineId);
  if (prior) prior.amountCents += e.amountCents; else list.push(e);
};

/** One person's open items, computed on every read like the balance: links first (capped by what each side has left),
 * then (with fifo) every credit's unapplied money settles the oldest open items. Sum of leftCents = max(balance, 0) with fifo. */
export function settle(entries: Tagged[], links: Link[], fifo = true): Settled {
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
      add(item.paybacks, { transactionId: p.transaction_id, lineId: p.line_id, date: p.date, amountCents: cents });
      if (!paidBack.has(pk)) paidBack.set(pk, []);
      add(paidBack.get(pk)!, { transactionId: item.entry.transaction_id, lineId: item.entry.line_id, amountCents: cents });
    }
  }
  const open = fifo ? [...items.values()] : [];
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

/** without: an entryKey settled as if it weren't in the ledger (the payback being edited). Then only the other paybacks' links
 * apply, no FIFO: explicit links override it, so unlinked money never closes an item this payback may link (R2). */
export function settlePerson(db: Db, personId: string, without?: string): Settled {
  const entries = personEntries(db, personId).filter((t) => entryKey(t.transaction_id, t.line_id) !== without);
  return settle(entries, personLinks(db, entries), without === undefined);
}

export const receiptIds = (db: Db): Set<string> =>
  new Set((db.prepare('SELECT transaction_id AS id FROM receipts').all() as { id: string }[]).map((r) => r.id));

export function openItems(s: Settled, receipts: Set<string>): OpenItem[] {
  return [...s.items.values()].filter((i) => i.leftCents > 0).map(({ entry: t, leftCents, paybacks }) => ({
    transactionId: t.transaction_id, lineId: t.line_id, date: t.date, payee: t.payee, totalCents: -t.amount, leftCents,
    hasReceipt: receipts.has(t.transaction_id), paybacks,
  }));
}

/** R6: a row's person changed, so it no longer pays or is paid by its old links. */
export function dropLinks(db: Db, txnId: string, lineId: string | null): void {
  db.prepare(`DELETE FROM iou_links WHERE (payback_transaction_id = ? AND payback_line_id IS ?) OR (item_transaction_id = ? AND item_line_id IS ?)`)
    .run(txnId, lineId, txnId, lineId);
}

type Line = { id: string; p: string | null; a: number };
/** pos: the old line's index (ORDER BY id), null when unsplit; rank: its index among the `peers` lines with the same person and sign. */
export type Captured = { link: Link; side: 'payback' | 'item'; personId: string | null; sign: number; pos: number | null; rank: number; peers: number };

const linesOf = (db: Db, txnId: string) =>
  db.prepare('SELECT id, person_id AS p, amount_cents AS a FROM split_lines WHERE transaction_id = ? ORDER BY id').all(txnId) as Line[];
const alike = (l: { p: string | null; a: number }) => (x: { p: string | null; a: number } | undefined) => x?.p === l.p && Math.sign(x.a) === Math.sign(l.a);

/** R3: split rewrites delete and recreate lines; remember which person (and which of their lines) each link on this transaction had. */
export function captureLinks(db: Db, txnId: string): Captured[] {
  const lines = linesOf(db, txnId);
  const row = db.prepare('SELECT person_id AS p, amount_cents AS a FROM transactions WHERE id = ?').get(txnId) as { p: string | null; a: number } | undefined;
  return (db.prepare('SELECT * FROM iou_links WHERE payback_transaction_id = ? OR item_transaction_id = ?').all(txnId, txnId) as Link[]).flatMap((link) => {
    const side = link.payback_transaction_id === txnId ? 'payback' : 'item';
    const lineId = side === 'payback' ? link.payback_line_id : link.item_line_id;
    const at = lineId ? lines.find((l) => l.id === lineId) : row;
    if (!at) return [];
    const peers = lines.filter(alike(at));
    return [{ link, side, personId: at.p, sign: Math.sign(at.a), pos: lineId ? lines.indexOf(at as Line) : null, rank: peers.indexOf(at as Line), peers: peers.length }];
  });
}

/** Retarget each captured link: to the row if it is unsplit and has that person, else (from an unsplit row) their first line with that sign.
 * Split → split: the line at the same position if it still has that person and sign; else, while that person's count of such lines
 * is unchanged (lines reordered), the one at the same rank among them; else the line's person changed and the link drops (R6). */
export function restoreLinks(db: Db, txnId: string, captured: Captured[]): void {
  const row = db.prepare('SELECT person_id AS p, amount_cents AS a FROM transactions WHERE id = ?').get(txnId) as { p: string | null; a: number } | undefined;
  const lines = linesOf(db, txnId);
  const del = db.prepare('DELETE FROM iou_links WHERE id = ?');
  const ins = db.prepare(`INSERT INTO iou_links (id, payback_transaction_id, payback_line_id, item_transaction_id, item_line_id, amount_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const c of captured) {
    del.run(c.link.id);
    if (!c.personId) continue;
    const same = alike({ p: c.personId, a: c.sign });
    const peers = lines.filter(same);
    const target = !lines.length ? (same(row) ? null : undefined)
      : c.pos === null ? peers[0]?.id : same(lines[c.pos]) ? lines[c.pos]!.id : peers.length === c.peers ? peers[c.rank]?.id : undefined;
    if (target === undefined) continue;
    const k = c.link;
    ins.run(k.id, k.payback_transaction_id, c.side === 'payback' ? target : k.payback_line_id, k.item_transaction_id,
      c.side === 'item' ? target : k.item_line_id, k.amount_cents, k.created_at);
  }
}
