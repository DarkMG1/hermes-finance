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
};

/** Fewer shares than this are float leftovers of fractional lots, not a holding. */
const DUST = 1e-6;
/** Plaid's tax-advantaged investment subtypes: sales there aren't taxable, but their buys still wash a taxable loss. */
const SHELTERED = new Set(['401a', '401k', '403b', '457b', '529', 'education savings account', 'health reimbursement arrangement', 'hsa', 'ira', 'keogh',
  'lif', 'lira', 'lrif', 'lrsp', 'non-taxable brokerage account', 'pension', 'prif', 'profit sharing plan', 'qshr', 'rdsp', 'resp', 'retirement', 'rlif',
  'roth', 'roth 401k', 'rrif', 'rrsp', 'sarsep', 'sep ira', 'simple ira', 'sipp', 'tfsa', 'thrift savings plan']);

/** `order` is the date FIFO goes by (the buy date, before any wash-sale tacking); `since` is when the lot can be sold (an entered or
 *  unverified lot is there from the start); `replaced` marks shares already used as some loss's wash-sale replacement. */
type Work = Lot & { order: string; since: string; key: string; sheltered: boolean; replaced: boolean };
type Row = { id: string; accountId: string; securityId: string; date: string; type: string; subtype: string | null; quantity: number; amountCents: number };

/** Held more than one year: bought on D, long-term from D + 1 year + 1 day. */
const termOf = (acquiredOn: string | null, sold: string): Sale['term'] =>
  acquiredOn === null ? 'unknown' : sold > `${Number(acquiredOn.slice(0, 4)) + 1}${acquiredOn.slice(4)}` ? 'long' : 'short';
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
  // entered lots fill those shares oldest first; one that no longer fits (the holding shrank) stays unverified so no sale plans on it
  const fits = new Set<string>();
  for (const e of entered) {
    const left = before.get(pair(e.accountId, e.securityId)) ?? 0;
    if (e.quantity - left < DUST) fits.add(e.id);
    before.set(pair(e.accountId, e.securityId), left - e.quantity);
  }
  return { tickerOf, rows, holdings, entered, before, fits };
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
  lots: Lot[]; sales: Sale[]; methods: Record<string, LotMethod>; inferred: Record<string, boolean>;
} {
  const accounts = db.prepare("SELECT id, subtype, lot_method AS lotMethod FROM accounts WHERE type = 'investment'")
    .all() as { id: string; subtype: string | null; lotMethod: LotMethod | null }[];
  const sheltered = new Map(accounts.map((a) => [a.id, SHELTERED.has((a.subtype ?? '').toLowerCase())]));
  const { tickerOf, rows, holdings, entered, before, fits } = load(db, asOf);
  const keyOf = (id: string) => holdingKey({ securityId: id, ticker: tickerOf(id), type: null, isCash: 0 });
  const holdingOf = new Map(holdings.map((h) => [pair(h.accountId, h.securityId), h]));

  const run = (methodOf: (accountId: string) => LotMethod) => {
    const work = (l: Omit<Lot, 'ticker'>, order: string, since: string): Work =>
      ({ ...l, ticker: tickerOf(l.securityId), order, since, key: keyOf(l.securityId), sheltered: sheltered.get(l.accountId)!, replaced: false });
    const lots: Work[] = [
      ...[...before].filter(([, q]) => q >= DUST).map(([p, quantity]) => {
        const [accountId, securityId] = p.split('\u0000') as [string, string];
        return work({ id: `unverified:${accountId}:${securityId}`, accountId, securityId, acquiredOn: null, quantity, costCents: 0, status: 'unverified' }, '', '');
      }),
      ...entered.map((e) => work({ ...e, status: fits.has(e.id) ? 'entered' : 'unverified' }, e.acquiredOn, '')),
      ...rows.filter((r) => r.type === 'buy').map((r) =>
        work({ id: r.id, accountId: r.accountId, securityId: r.securityId, acquiredOn: r.date, quantity: r.quantity, costCents: r.amountCents, status: 'known' }, r.date, r.date)),
    ];
    const sales: Sale[] = [];
    let splits = 0;
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
          // shares of the same security bought in any account within 30 days either side and still held replace them; the rest of the
          // sold lot itself never does (Rev. Rul. 56-602)
          const replacements = lots.filter((l) => l.key === p.lot!.key && l.status === 'known' && !l.replaced && l !== p.lot && l.quantity >= DUST
            && Math.abs(days(r.date, l.since)) <= 30).sort((a, b) => a.since.localeCompare(b.since));
          let washed = 0;
          for (const rep of replacements) {
            if (p.quantity - washed < DUST) break;
            const used = Math.min(rep.quantity, p.quantity - washed);
            let target = rep;
            if (rep.quantity - used >= DUST) {
              target = { ...rep, id: `${rep.id}:w${(splits += 1)}` };
              Object.assign(target, take(rep, used));
              lots.push(target);
            }
            washed += used;
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
    return { lots: lots.filter((l) => l.quantity >= DUST), sales };
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
  const { lots, sales } = run((id) => methods[id]!);
  return {
    lots: lots.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.securityId.localeCompare(b.securityId)
      || byMethod('fifo', (l: Work) => `${l.acquiredOn ?? ''}${l.order}`)(a, b))
      .map(({ id, accountId, securityId, ticker, acquiredOn, quantity, costCents, status }) => ({ id, accountId, securityId, ticker, acquiredOn, quantity, costCents, status })),
    sales, methods, inferred,
  };
}

/** The lots a sale of quantity shares would take. The owner picks lots only under "specific" (else highest cost first); any shortfall
 *  or unverified lot blocks the sale. */
export function planSale(lots: Lot[], method: LotMethod, accountId: string, securityId: string, quantity: number, chosenLotIds?: string[]): {
  taken: (Lot & { takeQuantity: number })[]; blocked: string | null;
} {
  const own = lots.filter((l) => l.accountId === accountId && l.securityId === securityId && l.quantity >= DUST);
  const ordered = method === 'specific' && chosenLotIds?.length
    ? chosenLotIds.flatMap((id) => own.filter((l) => l.id === id))
    : own.toSorted(byMethod(matchOf(method), (l) => l.acquiredOn ?? ''));
  const taken: (Lot & { takeQuantity: number })[] = [];
  let need = quantity;
  for (const l of ordered) {
    if (need < DUST) break;
    const takeQuantity = l.quantity - need < DUST ? l.quantity : need;
    taken.push({ ...l, takeQuantity });
    need -= takeQuantity;
  }
  const blocked = taken.some((l) => l.status === 'unverified')
    ? 'Some of these shares were bought before the transaction history: enter their purchase date and cost first'
    : need >= DUST ? `Only ${quantity - need} shares are in these lots` : null;
  return { taken, blocked };
}
