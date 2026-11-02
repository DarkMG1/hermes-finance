import { randomUUID } from 'node:crypto';
import { MAX_AMOUNT_CENTS, type Itemization, type SaveItemsBody, type Transaction } from '@hermes/shared';
import type { Db } from './db.ts';
import { localDay } from './days.ts';
import { ApiError } from './errors.ts';
import { captureLinks, restoreLinks } from './ious.ts';
import { getTransaction } from './ledger.ts';
import { assertPersonTaggable } from './people.ts';
import { writeSplit } from './splits.ts';

/** The owner, in item people lists and share results. */
export const ME = 'me';

type ShareItem = { amountCents: number; people: string[] };
export type ShareInput = { items: ShareItem[]; taxCents: number; tipCents: number; feesCents: number; targetCents: number };
export type ShareResult = { shares: { person: string; cents: number }[]; gapCents: number };

export class ShareError extends Error {
  constructor(message: string) { super(message); this.name = 'ShareError'; }
}

/**
 * Each person's share of `targetCents` (the bank amount, or the receipt total on a "they paid" row).
 * Items divide evenly among their people; an item's odd cents go to whoever has had the fewest so far (a discount's take back
 * from whoever has had the most), ties to "me" first, then list order. Everything else on the bill
 * (tax, tip, fees, any gap to the bank amount) follows each person's item total. Shares add up to the target exactly:
 * leftover cents go to "me" first when "me" had items, then by largest remainder, ties in first-appearance order.
 * The Swift twin is HermesKit's ItemShares; both are tested against shared/test-vectors/item-shares.json.
 */
export function computeShares(input: ShareInput): ShareResult {
  const { items, targetCents } = input;
  if (![targetCents, input.taxCents, input.tipCents, input.feesCents, ...items.map((i) => i.amountCents)]
    .every((n) => Number.isSafeInteger(n) && Math.abs(n) <= MAX_AMOUNT_CENTS)) throw new ShareError('amounts must be whole cents and at most 10,000,000.00');
  if (!items.length) throw new ShareError('add at least one item');
  if (targetCents <= 0) throw new ShareError('the total must be more than zero');
  const itemsTotal = items.reduce((s, i) => s + i.amountCents, 0);
  if (!Number.isSafeInteger(itemsTotal)) throw new ShareError('the items total is too large');
  if (itemsTotal <= 0) throw new ShareError('the items must add up to more than zero');
  const order: string[] = [];
  const base = new Map<string, number>();
  // odd cents each person has had so far, so they spread across the bill instead of piling on one person
  const odd = new Map<string, number>();
  for (const item of items) {
    if (!item.people.length) throw new ShareError('every item needs someone');
    if (new Set(item.people).size !== item.people.length) throw new ShareError('a person is listed twice on an item');
    for (const p of item.people) if (!order.includes(p)) order.push(p);
    const people = item.people.includes(ME) ? [ME, ...item.people.filter((p) => p !== ME)] : item.people;
    const each = Math.trunc(item.amountCents / people.length);
    const rem = item.amountCents - each * people.length;
    const s = Math.sign(rem);
    const takers = people.map((p, i) => ({ p, i })).sort((a, b) => s * ((odd.get(a.p) ?? 0) - (odd.get(b.p) ?? 0)) || a.i - b.i)
      .slice(0, Math.abs(rem)).map((x) => x.p);
    for (const p of people) base.set(p, (base.get(p) ?? 0) + each);
    for (const p of takers) { base.set(p, (base.get(p) ?? 0) + s); odd.set(p, (odd.get(p) ?? 0) + s); }
  }
  const people = order.includes(ME) ? [ME, ...order.filter((p) => p !== ME)] : order;
  for (const p of people) if ((base.get(p) ?? 0) <= 0) throw new ShareError("each person's items must add up to more than zero");
  const cents = new Map<string, number>();
  const frac = new Map<string, number>();
  for (const p of people) {
    const n = BigInt(base.get(p) ?? 0) * BigInt(targetCents);
    cents.set(p, Number(n / BigInt(itemsTotal)));
    frac.set(p, Number(n % BigInt(itemsTotal)));
  }
  let left = targetCents - [...cents.values()].reduce((a, b) => a + b, 0);
  const ranked = people.filter((p) => p !== ME).sort((a, b) => (frac.get(b) ?? 0) - (frac.get(a) ?? 0) || people.indexOf(a) - people.indexOf(b));
  const queue = people.includes(ME) ? [ME, ...ranked] : ranked;
  for (let i = 0; left > 0 && i < queue.length; i += 1, left -= 1) cents.set(queue[i]!, (cents.get(queue[i]!) ?? 0) + 1);
  if (left !== 0) throw new ShareError('the total could not be divided safely');
  if (people.some((p) => (cents.get(p) ?? 0) <= 0)) throw new ShareError("each person's share must be more than zero");
  return {
    shares: people.map((p) => ({ person: p, cents: cents.get(p) ?? 0 })),
    gapCents: targetCents - (itemsTotal + input.taxCents + input.tipCents + input.feesCents),
  };
}

type AppliedLine = { personId: string | null; amountCents: number };

/** What an items save leaves behind, in a form that later changes can be compared against. */
export function currentLines(db: Db, txnId: string): AppliedLine[] {
  const t = db.prepare('SELECT amount_cents, person_id, paid_by_person_id FROM transactions WHERE id = ?').get(txnId) as
    { amount_cents: number; person_id: string | null; paid_by_person_id: string | null };
  if (t.paid_by_person_id) return [{ personId: null, amountCents: t.amount_cents }];
  const lines = db.prepare('SELECT person_id, amount_cents FROM split_lines WHERE transaction_id = ? ORDER BY id').all(txnId) as
    { person_id: string | null; amount_cents: number }[];
  if (lines.length) return lines.map((l) => ({ personId: l.person_id, amountCents: l.amount_cents }));
  return [{ personId: t.person_id, amountCents: t.amount_cents }];
}

/** The caller has checked that the receipt exists. */
export function getItemization(db: Db, txnId: string): Itemization {
  const r = db.prepare('SELECT tax_cents, tip_cents, fees_cents, total_cents, read_at, applied_lines FROM receipts WHERE transaction_id = ?').get(txnId) as {
    tax_cents: number | null; tip_cents: number | null; fees_cents: number | null; total_cents: number | null; read_at: string | null; applied_lines: string | null;
  };
  const items = (db.prepare('SELECT id, name, amount_cents, people FROM receipt_items WHERE transaction_id = ? ORDER BY position').all(txnId) as
    { id: string; name: string; amount_cents: number; people: string }[])
    .map((i) => ({ id: i.id, name: i.name, amountCents: i.amount_cents, people: JSON.parse(i.people) as string[] }));
  return {
    items, taxCents: r.tax_cents, tipCents: r.tip_cents, feesCents: r.fees_cents, totalCents: r.total_cents, readAt: r.read_at,
    handEdited: r.applied_lines !== null && r.applied_lines !== JSON.stringify(currentLines(db, txnId)),
  };
}

export function replaceItems(db: Db, txnId: string, items: { name: string; amountCents: number; people: string[] }[]): void {
  db.prepare('DELETE FROM receipt_items WHERE transaction_id = ?').run(txnId);
  const insert = db.prepare('INSERT INTO receipt_items (id, transaction_id, position, name, amount_cents, people) VALUES (?, ?, ?, ?, ?, ?)');
  items.forEach((i, n) => insert.run(randomUUID(), txnId, n, i.name, i.amountCents, JSON.stringify(i.people)));
}

/** The items save: split (own purchase) or my share ("they paid"). The receipt exists; the row is live and money out. */
export function applyItems(db: Db, id: string, body: SaveItemsBody, nowIso: string): Transaction {
  const txn = getTransaction(db, id, localDay(new Date(nowIso)))!;
  const payer = txn.paidByPersonId;
  body.items.forEach((item, i) => item.people.forEach((p) => {
    if (p === ME) return;
    if (payer && p !== payer) throw new ApiError(400, 'INVALID_REQUEST', `items.${i}.people: only you and the person who paid`, `items.${i}.people`);
    assertPersonTaggable(db, p, `items.${i}.people`, id, payer ? 'payer' : 'person');
  }));
  const itemsTotal = body.items.reduce((s, i) => s + i.amountCents, 0);
  const target = payer ? itemsTotal + body.taxCents + body.tipCents + body.feesCents : -txn.amountCents;
  let shares;
  try {
    ({ shares } = computeShares({ items: body.items, taxCents: body.taxCents, tipCents: body.tipCents, feesCents: body.feesCents, targetCents: target }));
  } catch (e) {
    if (e instanceof ShareError) throw new ApiError(400, 'INVALID_REQUEST', `items: ${e.message}`, 'items');
    throw e;
  }
  if (payer) {
    const mine = shares.find((s) => s.person === ME)?.cents ?? 0;
    if (mine <= 0) throw new ApiError(400, 'INVALID_REQUEST', 'items: your share must be more than zero', 'items');
    db.prepare('UPDATE transactions SET amount_cents = ?, updated_at = ? WHERE id = ?').run(-mine, nowIso, id);
  } else {
    const ownerCategory = txn.splitLines.length ? (txn.splitLines.find((l) => !l.personId)?.categoryId ?? null) : txn.categoryId;
    const lines = shares.map((s) => s.person === ME
      ? { amountCents: -s.cents, categoryId: ownerCategory }
      : { amountCents: -s.cents, categoryId: null, personId: s.person });
    if (lines.length >= 2) {
      writeSplit(db, id, txn.amountCents, lines, 'items', nowIso);
    } else {
      // one share: no split; the whole row is mine (owner category) or that person's
      const kept = captureLinks(db, id);
      db.prepare('DELETE FROM split_lines WHERE transaction_id = ?').run(id);
      const only = shares[0]!.person;
      // all mine with no category: the flag stays as it was, so the bank category can still map once posted
      const category = only === ME ? ownerCategory : null;
      db.prepare('UPDATE transactions SET category_id = ?, person_id = ?, category_owner_set = CASE WHEN ? THEN category_owner_set ELSE 1 END, updated_at = ? WHERE id = ?')
        .run(category, only === ME ? null : only, only === ME && category === null ? 1 : 0, nowIso, id);
      restoreLinks(db, id, kept);
    }
  }
  replaceItems(db, id, body.items);
  db.prepare('UPDATE receipts SET tax_cents = ?, tip_cents = ?, fees_cents = ?, applied_lines = ? WHERE transaction_id = ?')
    .run(body.taxCents, body.tipCents, body.feesCents, JSON.stringify(currentLines(db, id)), id);
  return getTransaction(db, id, localDay(new Date(nowIso)))!;
}
