import { holdingKey } from '../backfill.ts';
import type { Db } from '../db.ts';
import { addDays } from '../days.ts';

export type LotMethod = 'fifo' | 'hifo' | 'specific';
export type Lot = {
  id: string; accountId: string; securityId: string; ticker: string | null; acquiredOn: string | null; quantity: number; costCents: number;
  status: 'known' | 'entered' | 'unverified';
};
export type Sale = {
  accountId: string; securityId: string; date: string; quantity: number; proceedsCents: number; costCents: number; acquiredOn: string | null;
  term: 'short' | 'long' | 'unknown'; washDisallowedCents: number; taxable: boolean;
  /** what-if sales only: the first day a short-term sale of these shares would be long-term */
  longTermOn?: string;
};
/** A lot as the calculator sees it: `boughtOn` is the raw buy (or entered) date, before any wash-sale tacking (null: unverified); `base` the
 *  buy or entered lot it was split from; `replaced` marks shares already used as some loss's wash-sale replacement. */
export type HeldLot = Lot & { boughtOn: string | null; base: string; replaced: boolean; entryId?: string };
/** All pre-history shares no entered lot covers, per position where past sales (not transfers) took some, a fully sold one too: entering their lots resolves those sales. */
export type Unresolved = { accountId: string; securityId: string; ticker: string | null; quantity: number };

/** Fewer shares than this are float leftovers of fractional lots, not a holding. */
export const DUST = 1e-6;
/** Plaid's tax-advantaged investment subtypes: sales there aren't taxable, but their buys still wash a taxable loss. */
export const SHELTERED = new Set(['401a', '401k', '403b', '457b', '529', 'education savings account', 'health reimbursement arrangement', 'hsa', 'ira', 'keogh',
  'lif', 'lira', 'lrif', 'lrsp', 'non-taxable brokerage account', 'pension', 'prif', 'profit sharing plan', 'qshr', 'rdsp', 'resp', 'retirement', 'rlif',
  'roth', 'roth 401k', 'rrif', 'rrsp', 'sarsep', 'sep ira', 'simple ira', 'sipp', 'tfsa', 'thrift savings plan']);

/** `order` is the date FIFO goes by (the buy date, before any wash-sale tacking); `since` is when the lot can be sold (an entered or
 *  unverified lot is there from the start); `replaced` marks shares already used as some loss's wash-sale replacement. */
type Work = Lot & { order: string; since: string; key: string; sheltered: boolean; replaced: boolean; base: string };
type Row = { id: string; accountId: string; securityId: string; date: string; type: string; subtype: string | null; quantity: number; amountCents: number };

/** Held more than one year: bought on D, long-term from D + 1 year + 1 day. */
export const termOf = (acquiredOn: string | null, sold: string): Sale['term'] =>
  acquiredOn === null ? 'unknown' : sold > `${Number(acquiredOn.slice(0, 4)) + 1}${acquiredOn.slice(4)}` ? 'long' : 'short';
/** The first day termOf calls a sale long-term (Feb 29 has no anniversary: Mar 1). */
export const longTermOn = (acquiredOn: string) =>
  acquiredOn.slice(5) === '02-29' ? `${Number(acquiredOn.slice(0, 4)) + 1}-03-01` : addDays(`${Number(acquiredOn.slice(0, 4)) + 1}${acquiredOn.slice(4)}`, 1);
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Unverified lots go first in every method: their date and cost are unknown, so any sale may be touching them. */
const byMethod = <T extends Lot>(match: 'fifo' | 'hifo', order: (l: T) => string) => (a: T, b: T) =>
  Number(b.status === 'unverified') - Number(a.status === 'unverified')
  || (match === 'hifo' ? b.costCents / b.quantity - a.costCents / a.quantity : 0)
  || order(a).localeCompare(order(b));
/** Past sales under "specific" lots are matched highest cost first, the way a broker harvesting losses picks them. */
const matchOf = (method: LotMethod) => (method === 'fifo' ? 'fifo' : 'hifo');

/** Takes q shares off a lot with cost in proportion; a remainder under DUST goes with them so no dust lot is left. */
function take(lot: { quantity: number; costCents: number }, q: number): { quantity: number; costCents: number } {
  if (lot.quantity - q < DUST) {
    const all = { quantity: lot.quantity, costCents: lot.costCents };
    lot.quantity = 0;
    lot.costCents = 0;
    return all;
  }
  const costCents = Math.round(lot.costCents * q / lot.quantity);
  lot.quantity -= q;
  lot.costCents -= costCents;
  return { quantity: q, costCents };
}

const pair = (accountId: string, securityId: string) => `${accountId}\u0000${securityId}`;

function load(db: Db, asOf: string) {
  const secs = new Map((db.prepare('SELECT id, ticker, type, is_cash AS isCash FROM securities').all() as { id: string; ticker: string | null; type: string | null; isCash: number }[])
    .map((s) => [s.id, s]));
  const isCash = (id: string) => secs.get(id)?.isCash === 1 || secs.get(id)?.type === 'cash';
  const tickerOf = (id: string) => secs.get(id)?.ticker ?? null;

  // shortcut: split rows are skipped, so a split's new shares land in the unverified lot; handle splits if an account ever has one
  const rows = (db.prepare(`SELECT t.id, t.account_id AS accountId, t.security_id AS securityId, t.date, t.type, t.subtype, t.quantity, t.amount_cents AS amountCents
    FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.type = 'investment' AND t.security_id IS NOT NULL AND t.date <= ?
      AND ((t.type = 'buy' AND t.quantity > 0) OR (t.type = 'sell' AND t.quantity < 0) OR (t.type = 'transfer' AND t.quantity < 0))
    ORDER BY t.date, t.type, t.id`).all(asOf) as Row[])
    .filter((r) => !isCash(r.securityId) && !(r.subtype ?? '').toLowerCase().includes('split'));
  const holdings = (db.prepare(`SELECT h.account_id AS accountId, h.security_id AS securityId, h.quantity, h.cost_basis_cents AS basisCents
    FROM holdings h JOIN accounts a ON a.id = h.account_id WHERE a.type = 'investment'`).all() as { accountId: string; securityId: string; quantity: number; basisCents: number | null }[])
    .filter((h) => !isCash(h.securityId));
  const entered = db.prepare(`SELECT e.id, e.account_id AS accountId, e.security_id AS securityId, e.acquired_on AS acquiredOn, e.quantity, e.cost_cents AS costCents
    FROM lot_entries e JOIN accounts a ON a.id = e.account_id WHERE a.type = 'investment' ORDER BY e.acquired_on, e.id`).all() as (Omit<Lot, 'ticker' | 'status'> & { acquiredOn: string })[];

  // shares held before the history = holding − the history's net (buys add, sells and transfers out remove); entered lots then come off
  const before = new Map<string, number>(holdings.map((h) => [pair(h.accountId, h.securityId), h.quantity]));
  for (const r of rows) before.set(pair(r.accountId, r.securityId), (before.get(pair(r.accountId, r.securityId)) ?? 0) - r.quantity);
  // below 0: the history adds up to more shares than are held (a reverse split, a cancelled trade, an outflow it lacks, a stale holding)
  const mismatched = new Set([...before].filter(([, q]) => q <= -DUST).map(([p]) => p));
  // entered lots fill those shares oldest first; one that no longer fits (the holding shrank) stays unverified so no sale plans on it
  const fits = new Set<string>();
  for (const e of entered) {
    const left = before.get(pair(e.accountId, e.securityId)) ?? 0;
    if (e.quantity - left < DUST) fits.add(e.id);
    before.set(pair(e.accountId, e.securityId), left - e.quantity);
  }
  return { tickerOf, rows, holdings, entered, before, fits, mismatched };
}

/** Shares held before the history that no entered lot covers yet: the most a new entered lot may hold. */
export function preHistoryRemainder(db: Db, accountId: string, securityId: string, asOf: string): number {
  return Math.max(0, load(db, asOf).before.get(pair(accountId, securityId)) ?? 0);
}

/**
 * Lots and realized sales from stored Plaid investment transactions up to asOf.
 * Plaid's signs, as stored: a buy has quantity > 0 and amount > 0 (cash leaves the account); a sell has quantity < 0 and amount < 0
 * (backfill.ts replays shares as `before = after - quantity`). Rows with no security, cash securities (sweeps), dividends, fees and
 * deposits make no lots. Shares held before the history (holding minus the history's net) form one unverified lot per account and
 * security, less any lots the owner entered for them.
 */
export function buildLots(db: Db, asOf: string): {
  lots: HeldLot[]; sales: Sale[]; methods: Record<string, LotMethod>;
  /** inferred: no owner-set method; basisMatched: the inferred method reproduces the broker's basis (false: FIFO by default) */
  inferred: Record<string, boolean>; basisMatched: Record<string, boolean>; unresolved: Unresolved[];
  /** positions whose history adds up to more shares than held: their lots are unverified */
  mismatched: { accountId: string; securityId: string; ticker: string | null }[];
  /** stored buys (raw date) and the shares of each buy or entered lot ever used as a wash-sale replacement */
  buys: { id: string; securityId: string; date: string; quantity: number }[]; washUsed: Map<string, number>;
} {
  const accounts = db.prepare("SELECT id, subtype, lot_method AS lotMethod FROM accounts WHERE type = 'investment'")
    .all() as { id: string; subtype: string | null; lotMethod: LotMethod | null }[];
  const sheltered = new Map(accounts.map((a) => [a.id, SHELTERED.has((a.subtype ?? '').toLowerCase())]));
  const { tickerOf, rows, holdings, entered, before, fits, mismatched } = load(db, asOf);
  const keyOf = (id: string) => holdingKey({ securityId: id, ticker: tickerOf(id), type: null, isCash: 0 });
  const holdingOf = new Map(holdings.map((h) => [pair(h.accountId, h.securityId), h]));

  const run = (methodOf: (accountId: string) => LotMethod) => {
    const work = (l: Omit<Lot, 'ticker'>, order: string, since: string): Work =>
      ({ ...l, ticker: tickerOf(l.securityId), order, since, key: keyOf(l.securityId), sheltered: sheltered.get(l.accountId)!, replaced: false, base: l.id });
    const lots: Work[] = [
      ...[...before].filter(([, q]) => q >= DUST).map(([p, quantity]) => {
        const [accountId, securityId] = p.split('\u0000') as [string, string];
        return work({ id: `unverified:${accountId}:${securityId}`, accountId, securityId, acquiredOn: null, quantity, costCents: 0, status: 'unverified' }, '', '');
      }),
      // an entered lot can't be sold before the date the owner says it was bought
      ...entered.map((e) => work({ ...e, status: fits.has(e.id) ? 'entered' : 'unverified' }, e.acquiredOn, e.acquiredOn)),
      ...rows.filter((r) => r.type === 'buy').map((r) =>
        work({ id: r.id, accountId: r.accountId, securityId: r.securityId, acquiredOn: r.date, quantity: r.quantity, costCents: r.amountCents, status: 'known' }, r.date, r.date)),
    ];
    const sales: Sale[] = [];
    const washUsed = new Map<string, number>();
    const preSold = new Set<string>();
    for (const r of rows) {
      if (r.type === 'buy') continue;
      const pool = lots.filter((l) => l.accountId === r.accountId && l.securityId === r.securityId && l.quantity >= DUST && l.since <= r.date)
        .sort(byMethod(matchOf(methodOf(r.accountId)), (l) => l.order));
      let need = -r.quantity;
      const parts: { lot: Work | null; quantity: number; costCents: number }[] = [];
      for (const lot of pool) {
        if (need < DUST) break;
        const t = take(lot, Math.min(need, lot.quantity));
        need -= t.quantity;
        if (lot.id.startsWith('unverified:') && r.type !== 'transfer' && t.quantity >= DUST) preSold.add(pair(lot.accountId, lot.securityId));
        parts.push({ lot, ...t });
      }
      // more shares sold than the history and holdings account for: like an unverified lot, date and cost unknown
      if (need >= DUST) parts.push({ lot: null, quantity: need, costCents: 0 });
      if (r.type === 'transfer') continue;

      const taxable = !sheltered.get(r.accountId);
      const sold = parts.reduce((a, p) => a + p.quantity, 0);
      let proceedsLeft = -r.amountCents;
      parts.forEach((p, i) => {
        const proceedsCents = i === parts.length - 1 ? proceedsLeft : Math.round(-r.amountCents * p.quantity / sold);
        proceedsLeft -= proceedsCents;
        const known = p.lot !== null && p.lot.status !== 'unverified';
        // an unknown cost counts no gain; the sale's term says so
        const costCents = known ? p.costCents : proceedsCents;
        const acquiredOn = known ? p.lot!.acquiredOn : null;
        const loss = costCents - proceedsCents;
        let washDisallowedCents = 0;
        if (taxable && loss > 0) {
          // shares of the same security bought (or entered as bought) in any account within 30 days either side and still held replace them;
          // the rest of the sold lot itself never does (Rev. Rul. 56-602)
          const replacements = lots.filter((l) => l.key === p.lot!.key && l.status !== 'unverified' && !l.replaced && l.base !== p.lot!.base && l.quantity >= DUST
            && Math.abs(days(r.date, l.order)) <= 30).sort((a, b) => a.order.localeCompare(b.order));
          let washed = 0;
          for (const rep of replacements) {
            if (p.quantity - washed < DUST) break;
            const used = Math.min(rep.quantity, p.quantity - washed);
            let target = rep;
            if (rep.quantity - used >= DUST) {
              // named by the sale row and part, so the ids survive a sync that adds unrelated rows
              target = { ...rep, id: `${rep.id}:w${r.id}.${i}` };
              Object.assign(target, take(rep, used));
              lots.push(target);
            }
            washed += used;
            washUsed.set(rep.base, (washUsed.get(rep.base) ?? 0) + used);
            const disallowed = Math.round(loss * Math.min(1, washed / p.quantity));
            target.replaced = true;
            // a tax-advantaged account's basis doesn't move: the loss there is lost for good
            if (!target.sheltered) {
              target.costCents += disallowed - washDisallowedCents;
              if (acquiredOn) target.acquiredOn = addDays(target.acquiredOn!, -days(acquiredOn, r.date));
            }
            washDisallowedCents = disallowed;
          }
        }
        sales.push({ accountId: r.accountId, securityId: r.securityId, date: r.date, quantity: p.quantity, proceedsCents, costCents, acquiredOn,
          term: termOf(acquiredOn, r.date), washDisallowedCents, taxable });
      });
    }
    // what's left unverified costs the holding's basis less every other lot still held (0 when the broker reports no basis)
    for (const u of lots.filter((l) => l.id.startsWith('unverified:') && l.quantity >= DUST)) {
      const others = lots.filter((l) => l !== u && l.accountId === u.accountId && l.securityId === u.securityId && l.quantity >= DUST)
        .reduce((a, l) => a + l.costCents, 0);
      u.costCents = Math.max(0, (holdingOf.get(pair(u.accountId, u.securityId))?.basisCents ?? 0) - others);
    }
    return { lots: lots.filter((l) => l.quantity >= DUST), sales, washUsed, preSold };
  };

  /** Remaining cost of lots in holdings the broker reports a basis for and that hold no unverified shares, against that basis. */
  const matches = (lots: Work[], accountId: string) => {
    let diff = 0;
    for (const h of holdings.filter((x) => x.accountId === accountId && x.basisCents !== null)) {
      const own = lots.filter((l) => l.accountId === accountId && l.securityId === h.securityId);
      if (own.some((l) => l.status === 'unverified')) continue;
      diff += Math.abs(own.reduce((a, l) => a + l.costCents, 0) - h.basisCents!);
    }
    return diff <= 100;
  };
  const fifo = run(() => 'fifo');
  const hifo = run(() => 'hifo');
  const methods = Object.fromEntries(accounts.map((a) =>
    [a.id, a.lotMethod ?? (!matches(fifo.lots, a.id) && matches(hifo.lots, a.id) ? 'hifo' : 'fifo')])) as Record<string, LotMethod>;
  const inferred = Object.fromEntries(accounts.map((a) => [a.id, a.lotMethod === null]));
  const basisMatched = Object.fromEntries(accounts.map((a) => [a.id, a.lotMethod === null && matches(methods[a.id] === 'hifo' ? hifo.lots : fifo.lots, a.id)]));
  const { lots, sales, washUsed, preSold } = run((id) => methods[id]!);
  const split = (p: string) => p.split('\u0000') as [string, string];
  const entryIds = new Set(entered.map((e) => e.id));
  return {
    lots: lots.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.securityId.localeCompare(b.securityId)
      || byMethod('fifo', (l: Work) => `${l.acquiredOn ?? ''}${l.order}`)(a, b))
      .map(({ id, accountId, securityId, ticker, acquiredOn, quantity, costCents, status, order, base, replaced }) => ({
        id, accountId, securityId, ticker, acquiredOn, quantity, costCents, replaced, base, boughtOn: status === 'unverified' ? null : order,
        status: mismatched.has(pair(accountId, securityId)) ? 'unverified' : status,
        // the owner's lot_entries row it came from (also when unverified or wash-split): the id DELETE /v1/tax/lots/:id takes
        ...(entryIds.has(base) ? { entryId: base } : {}),
      })),
    sales, methods, inferred, basisMatched,
    // the whole pre-history quantity no entered lot covers, not just the sold part: entering the true lots resolves the sales
    unresolved: [...preSold].map((p) => {
      const [accountId, securityId] = split(p);
      return { accountId, securityId, ticker: tickerOf(securityId), quantity: before.get(p)! };
    }),
    mismatched: [...mismatched].map((p) => { const [accountId, securityId] = split(p); return { accountId, securityId, ticker: tickerOf(securityId) }; }),
    buys: rows.filter((r) => r.type === 'buy').map(({ id, securityId, date, quantity }) => ({ id, securityId, date, quantity })),
    washUsed,
  };
}

/** What the API and Ask show of the lots: no calculator bookkeeping. */
export function lotsView(b: ReturnType<typeof buildLots>) {
  return {
    lots: b.lots.map(({ id, accountId, securityId, ticker, acquiredOn, quantity, costCents, status, entryId }) =>
      ({ id, accountId, securityId, ticker, acquiredOn, quantity, costCents, status, ...(entryId ? { entryId } : {}) })),
    sales: b.sales, methods: b.methods, inferred: b.inferred, basisMatched: b.basisMatched, unresolved: b.unresolved,
  };
}

/** The lots a sale of quantity shares would take. The owner picks lots only under "specific" (else highest cost first); any shortfall
 *  or unverified lot blocks the sale. */
export function planSale<T extends Lot>(lots: T[], method: LotMethod, accountId: string, securityId: string, quantity: number, chosenLotIds?: string[]): {
  taken: (T & { takeQuantity: number })[]; blocked: string | null;
} {
  if (chosenLotIds && new Set(chosenLotIds).size !== chosenLotIds.length) return { taken: [], blocked: 'The same lot is chosen more than once' };
  const own = lots.filter((l) => l.accountId === accountId && l.securityId === securityId && l.quantity >= DUST);
  // FIFO goes by the buy date, not a date moved back by a wash sale
  const ordered = method === 'specific' && chosenLotIds?.length
    ? chosenLotIds.flatMap((id) => own.filter((l) => l.id === id))
    : own.toSorted(byMethod(matchOf(method), (l) => ('boughtOn' in l ? l.boughtOn as string | null : null) ?? l.acquiredOn ?? ''));
  const taken: (T & { takeQuantity: number })[] = [];
  let need = quantity;
  for (const l of ordered) {
    if (need < DUST) break;
    const takeQuantity = l.quantity - need < DUST ? l.quantity : need;
    taken.push({ ...l, takeQuantity });
    need -= takeQuantity;
  }
  const blocked = taken.some((l) => l.status === 'unverified')
    ? 'Some of these shares were bought before the transaction history: enter their purchase date and cost first'
    : need >= DUST ? `Only ${+(quantity - need).toFixed(6)} shares are in these lots` : null;
  return { taken, blocked };
}

export const isSheltered = (db: Db, accountId: string) =>
  SHELTERED.has(String(db.prepare('SELECT subtype FROM accounts WHERE id = ?').pluck().get(accountId) ?? '').toLowerCase());

/**
 * Proposed sales on `date` at each holding's last synced price, planned together as one set. A loss is washed by shares of the same holding
 * (any account) bought in the 30 days up to the date, by raw buy date: shares still held after the whole set, and shares bought then and
 * already sold; never the sold lot's own other shares, nor shares already used as a past wash's replacement. Buys after today aren't known.
 * Replacements are never sold in the set, so the disallowed loss moves to shares no later sale in it touches.
 */
export function planSales(db: Db, built: ReturnType<typeof buildLots>, sell: { accountId: string; securityId: string; quantity: number; lotIds?: string[] }[], date: string):
  { sales: Sale[]; blocked: string | null; washedBySold: boolean } {
  const left = built.lots.map((l) => ({ ...l }));
  const parts: { lot: HeldLot; quantity: number; costCents: number; proceedsCents: number; taxable: boolean }[] = [];
  for (const s of sell) {
    const price = db.prepare('SELECT price_cents FROM holdings WHERE account_id = ? AND security_id = ?').pluck().get(s.accountId, s.securityId) as number | undefined;
    if (price === undefined || !left.some((l) => l.accountId === s.accountId && l.securityId === s.securityId)) return { sales: [], blocked: 'No current holding to sell', washedBySold: false };
    const { taken, blocked } = planSale(left, built.methods[s.accountId] ?? 'fifo', s.accountId, s.securityId, s.quantity, s.lotIds);
    if (blocked) return { sales: [], blocked, washedBySold: false };
    const taxable = !isSheltered(db, s.accountId);
    for (const t of taken) {
      const lot = left.find((l) => l.id === t.id)!;
      const original = { ...lot };
      const got = take(lot, t.takeQuantity);
      parts.push({ lot: original, ...got, proceedsCents: Math.round(price * got.quantity), taxable });
    }
  }

  const keyOf = (securityId: string, ticker: string | null) => holdingKey({ securityId, ticker, type: null, isCash: 0 });
  const tickers = new Map(built.lots.map((l) => [l.securityId, l.ticker]));
  const from = addDays(date, -30);
  // free replacement shares per buy or entered lot: held after the set, plus bought in the window and since sold
  const free = new Map<string, { key: string; on: string; held: number; sold: number }>();
  for (const l of left) {
    if (l.status === 'unverified' || l.replaced || !l.boughtOn || l.boughtOn < from || l.boughtOn > date || l.quantity < DUST) continue;
    const f = free.get(l.base) ?? { key: keyOf(l.securityId, l.ticker), on: l.boughtOn, held: 0, sold: 0 };
    f.held += l.quantity;
    free.set(l.base, f);
  }
  for (const b of built.buys.filter((x) => x.date >= from && x.date <= date)) {
    const pieces = built.lots.filter((l) => l.base === b.id);
    const held = pieces.reduce((a, l) => a + l.quantity, 0);
    const replacedHeld = pieces.filter((l) => l.replaced).reduce((a, l) => a + l.quantity, 0);
    const sold = b.quantity - held - Math.max(0, (built.washUsed.get(b.id) ?? 0) - replacedHeld);
    if (sold < DUST) continue;
    const ticker = tickers.get(b.securityId) ?? db.prepare('SELECT ticker FROM securities WHERE id = ?').pluck().get(b.securityId) as string | null ?? null;
    const f = free.get(b.id) ?? { key: keyOf(b.securityId, ticker), on: b.date, held: 0, sold: 0 };
    f.sold += sold;
    free.set(b.id, f);
  }
  const pool = [...free].sort(([, a], [, b]) => a.on.localeCompare(b.on));

  let washedBySold = false;
  const sales = parts.map((p): Sale => {
    let washed = 0;
    if (p.taxable && p.costCents > p.proceedsCents) {
      for (const [base, f] of pool) {
        if (f.key !== keyOf(p.lot.securityId, p.lot.ticker) || base === p.lot.base) continue;
        for (const part of ['held', 'sold'] as const) {
          const used = Math.min(f[part], p.quantity - washed);
          f[part] -= used;
          washed += used;
          if (part === 'sold' && used >= DUST) washedBySold = true;
        }
      }
    }
    const term = termOf(p.lot.acquiredOn, date);
    return { accountId: p.lot.accountId, securityId: p.lot.securityId, date, quantity: p.quantity, proceedsCents: p.proceedsCents, costCents: p.costCents,
      acquiredOn: p.lot.acquiredOn, term, washDisallowedCents: washed >= DUST ? Math.round((p.costCents - p.proceedsCents) * Math.min(1, washed / p.quantity)) : 0,
      taxable: p.taxable, ...(term === 'short' && { longTermOn: longTermOn(p.lot.acquiredOn!) }) };
  });
  return { sales, blocked: null, washedBySold };
}
