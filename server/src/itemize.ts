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
  return {
    shares: people.map((p) => ({ person: p, cents: cents.get(p) ?? 0 })),
    gapCents: targetCents - (itemsTotal + input.taxCents + input.tipCents + input.feesCents),
  };
}
