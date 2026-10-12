import type { Itemization } from '@hermes/shared';
import type { Db } from './db.ts';

/** The owner, in item people lists and share results. */
export const ME = 'me';

export type ShareItem = { amountCents: number; people: string[] };
export type ShareInput = { items: ShareItem[]; taxCents: number; tipCents: number; feesCents: number; targetCents: number };
export type ShareResult = { shares: { person: string; cents: number }[]; gapCents: number };

export class ShareError extends Error {
  constructor(message: string) { super(message); this.name = 'ShareError'; }
}

/**
 * Each person's share of `targetCents` (the bank amount, or the receipt total on a "they paid" row).
 * Items divide evenly among their people (odd cents to "me" first, then list order); everything else on the bill
 * (tax, tip, fees, any gap to the bank amount) follows each person's item total. Shares add up to the target exactly:
 * leftover cents go to "me" first when "me" had items, then by largest remainder, ties in first-appearance order.
 * The Swift twin is HermesKit's ItemShares; both are tested against shared/test-vectors/item-shares.json.
 */
export function computeShares(input: ShareInput): ShareResult {
  const { items, targetCents } = input;
  if (!items.length) throw new ShareError('add at least one item');
  if (targetCents <= 0) throw new ShareError('the total must be more than zero');
  const itemsTotal = items.reduce((s, i) => s + i.amountCents, 0);
  if (itemsTotal <= 0) throw new ShareError('the items must add up to more than zero');
  const order: string[] = [];
  const base = new Map<string, number>();
  for (const item of items) {
    if (!item.people.length) throw new ShareError('every item needs someone');
    if (new Set(item.people).size !== item.people.length) throw new ShareError('a person is listed twice on an item');
    for (const p of item.people) if (!order.includes(p)) order.push(p);
    const people = item.people.includes(ME) ? [ME, ...item.people.filter((p) => p !== ME)] : item.people;
    const each = Math.trunc(item.amountCents / people.length);
    const rem = item.amountCents - each * people.length;
    people.forEach((p, i) => base.set(p, (base.get(p) ?? 0) + each + (i < Math.abs(rem) ? Math.sign(rem) : 0)));
  }
  const people = order.includes(ME) ? [ME, ...order.filter((p) => p !== ME)] : order;
  for (const p of people) if ((base.get(p) ?? 0) <= 0) throw new ShareError("each person's items must add up to more than zero");
  const cents = new Map<string, number>();
  const frac = new Map<string, number>();
  for (const p of people) {
    const n = (base.get(p) ?? 0) * targetCents;
    cents.set(p, Math.floor(n / itemsTotal));
    frac.set(p, n % itemsTotal);
  }
  let left = targetCents - [...cents.values()].reduce((a, b) => a + b, 0);
  const ranked = people.filter((p) => p !== ME).sort((a, b) => (frac.get(b) ?? 0) - (frac.get(a) ?? 0) || people.indexOf(a) - people.indexOf(b));
  const queue = people.includes(ME) ? [ME, ...ranked] : ranked;
  for (let i = 0; left > 0; i += 1, left -= 1) cents.set(queue[i]!, (cents.get(queue[i]!) ?? 0) + 1);
  if (people.some((p) => (cents.get(p) ?? 0) <= 0)) throw new ShareError("each person's share must be more than zero");
  return {
    shares: people.map((p) => ({ person: p, cents: cents.get(p) ?? 0 })),
    gapCents: targetCents - (itemsTotal + input.taxCents + input.tipCents + input.feesCents),
  };
}

export type AppliedLine = { personId: string | null; amountCents: number };

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
