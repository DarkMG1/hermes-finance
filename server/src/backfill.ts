import type { Db } from './db.ts';
import { addDays } from './days.ts';

/** Holdings of one ticker combine across accounts; every cash position is one "Cash" holding, keyed `_cash` (no ticker has an underscore). */
export function holdingKey(s: { securityId: string; ticker: string | null; type: string | null; isCash: number | boolean }): string {
  if (s.isCash === true || s.isCash === 1 || s.type === 'cash') return '_cash';
  return s.ticker ? s.ticker.toUpperCase() : s.securityId;
}

type DayValue = { totalCents: number; cashCents: number; bySecurity: Map<string, number>; excluded: Set<string> };
export type AccountEstimate = { accountId: string; anchor: string; earliest: string; valueOn(day: string): DayValue };

type Sec = { id: string; ticker: string | null; type: string | null; isCash: number };
type Txn = { securityId: string | null; date: string; type: string; quantity: number; amountCents: number; priceCents: number | null; subtype: string | null };

const isCashSec = (s: Sec | undefined) => s !== undefined && (s.isCash === 1 || s.type === 'cash');
const isSplit = (t: Txn) => (t.subtype ?? '').toLowerCase().includes('split');
const movesShares = (t: Txn) => t.securityId !== null && (t.type === 'buy' || t.type === 'sell' || t.type === 'transfer');
/** Only these have Tiingo prices; any other ticker (crypto, bonds, options) may name an unrelated stock. */
export const PRICED_TYPES = ['equity', 'etf', 'mutual fund'];

/** Latest index with dates[i] <= day, or -1. */
function atOrBefore(dates: string[], day: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * An investment account's value on days before its first holdings sync (anchor), in today's share units:
 * shares and cash walk back from the anchor through stored investment transactions; each day is priced from Tiingo closes,
 * with trade/anchor fallbacks only for securities with a supported price history. Unpriced positions are excluded.
 * Null when the account never synced holdings or held nothing at its first sync.
 */
export function loadAccountEstimate(db: Db, accountId: string): AccountEstimate | null {
  const anchor = (db.prepare('SELECT MIN(date) AS d FROM holding_syncs WHERE account_id = ?').get(accountId) as { d: string | null }).d;
  if (!anchor) return null;
  const rows = db.prepare('SELECT security_id AS securityId, quantity, value_cents AS valueCents FROM holding_snapshots WHERE account_id = ? AND date = ?')
    .all(accountId, anchor) as { securityId: string; quantity: number; valueCents: number }[];
  // nothing held at the anchor (holdings not reported): hold the first balance snapshot flat instead
  if (rows.length === 0) return null;
  const secs = new Map((db.prepare('SELECT id, ticker, type, is_cash AS isCash FROM securities').all() as Sec[]).map((s) => [s.id, s]));
  const tickerOf = (id: string) => {
    const s = secs.get(id);
    return s?.ticker && PRICED_TYPES.includes(s.type ?? '') ? s.ticker.toUpperCase() : null;
  };

  const shares = new Map<string, number>();
  const anchorPrice = new Map<string, number>();
  let cash = 0;
  for (const h of rows) {
    if (isCashSec(secs.get(h.securityId))) { cash += h.valueCents; continue; }
    shares.set(h.securityId, (shares.get(h.securityId) ?? 0) + h.quantity);
    if (h.quantity !== 0) anchorPrice.set(h.securityId, h.valueCents / h.quantity);
  }

  const txns = (db.prepare(`SELECT security_id AS securityId, date, type, quantity, amount_cents AS amountCents, price_cents AS priceCents, subtype
    FROM investment_transactions WHERE account_id = ? AND date <= ? ORDER BY date`).all(accountId, anchor) as Txn[])
    // buys and sells of a cash security are sweeps between cash forms; its other rows (deposits, fees, distributions) move cash
    .filter((t) => !(t.securityId && isCashSec(secs.get(t.securityId)) && (t.type === 'buy' || t.type === 'sell')));
  const earliest = txns[0]?.date ?? anchor;

  const ids = new Set<string>([...shares.keys(), ...txns.flatMap((t) => (t.securityId ? [t.securityId] : []))]);
  const tickers = [...new Set([...ids].map(tickerOf).filter((t): t is string => t !== null))];
  const closes = new Map<string, { dates: string[]; cents: number[]; splits: [string, number][] }>();
  const priceRows = db.prepare('SELECT date, close_cents AS cents, split_factor AS split FROM security_prices WHERE ticker = ? AND date <= ? ORDER BY date');
  for (const t of tickers) {
    const rows = priceRows.all(t, anchor) as { date: string; cents: number; split: number }[];
    closes.set(t, { dates: rows.map((r) => r.date), cents: rows.map((r) => r.cents), splits: rows.filter((r) => r.split !== 1).map((r) => [r.date, r.split]) });
  }
  /** Π split factors for split dates in (day, anchor]: converts a day's units into today's. */
  const splitsAfter = (ticker: string | null, day: string) =>
    (ticker ? closes.get(ticker)?.splits ?? [] : []).reduce((f, [d, s]) => (d > day ? f * s : f), 1);
  /** A Plaid split Tiingo records within 3 days is already in the price conversion. */
  const tiingoSplit = (t: Txn) => {
    const ticker = t.securityId ? tickerOf(t.securityId) : null;
    const from = addDays(t.date, -3);
    const to = addDays(t.date, 3);
    return (ticker ? closes.get(ticker)?.splits ?? [] : []).some(([d]) => d >= from && d <= to);
  };
  const plaidSplits = new Map<string, [string, number][]>();
  const quantities = new Map(shares);
  for (const t of txns.toReversed()) {
    if (!t.securityId || !movesShares(t) || isCashSec(secs.get(t.securityId)) || (isSplit(t) && tiingoSplit(t))) continue;
    const after = quantities.get(t.securityId) ?? 0;
    const before = after - t.quantity * splitsAfter(tickerOf(t.securityId), t.date);
    const factor = after / before;
    if (isSplit(t) && Number.isFinite(factor) && factor > 0) {
      plaidSplits.set(t.securityId, [...(plaidSplits.get(t.securityId) ?? []), [t.date, factor]]);
    }
    quantities.set(t.securityId, before);
  }
  const plaidAfter = (id: string, day: string) => (plaidSplits.get(id) ?? []).reduce((f, [d, s]) => (d > day ? f * s : f), 1);
  // only buys and sells provide execution prices
  const trades = new Map<string, { dates: string[]; txns: Txn[] }>();
  for (const t of txns) {
    if (!t.securityId || !movesShares(t) || t.type === 'transfer' || isCashSec(secs.get(t.securityId)) || t.priceCents === null || t.priceCents <= 0 || t.quantity === 0 || isSplit(t)) continue;
    const tr = trades.get(t.securityId) ?? { dates: [], txns: [] };
    tr.dates.push(t.date);
    tr.txns.push(t);
    trades.set(t.securityId, tr);
  }

  const priceOn = (id: string, day: string): number | null => {
    const ticker = tickerOf(id);
    const c = ticker ? closes.get(ticker) : undefined;
    if (!c?.dates.length) return null;
    const i = atOrBefore(c.dates, day);
    if (i >= 0) return c.cents[i]! / splitsAfter(ticker, day) * plaidAfter(id, day) / plaidAfter(id, c.dates[i]!);
    const tr = trades.get(id);
    const j = tr ? atOrBefore(tr.dates, day) : -1;
    if (tr && j >= 0) return tr.txns[j]!.priceCents! / splitsAfter(ticker, tr.txns[j]!.date) * plaidAfter(id, day) / plaidAfter(id, tr.txns[j]!.date);
    const a = anchorPrice.get(id);
    if (a !== undefined) return a * plaidAfter(id, day);
    // sold before the anchor and before its first close: its earliest trade price
    const e = tr?.txns[0];
    return e ? e.priceCents! / splitsAfter(ticker, e.date) * plaidAfter(id, day) / plaidAfter(id, e.date) : 0;
  };
  const value = (day: string): DayValue => {
    const bySecurity = new Map<string, number>();
    const excluded = new Set<string>();
    let total = cash;
    for (const [id, q] of shares) {
      if (Math.abs(q) < 1e-9) continue;
      const price = priceOn(id, day);
      if (price === null) { excluded.add(id); continue; }
      const v = Math.round(q * price);
      bySecurity.set(id, v);
      total += v;
    }
    return { totalCents: total, cashCents: cash, bySecurity, excluded };
  };
  const undo = (t: Txn) => {
    if (movesShares(t) && isSplit(t) && tiingoSplit(t)) return;
    // a contribution's buy is paid from outside the account, not from its cash
    if (!(t.type === 'buy' && (t.subtype ?? '').toLowerCase().includes('contribution'))) cash += t.amountCents;
    if (!t.securityId || !movesShares(t) || isCashSec(secs.get(t.securityId))) return;
    shares.set(t.securityId, (shares.get(t.securityId) ?? 0) - t.quantity * splitsAfter(tickerOf(t.securityId), t.date));
  };

  // on and after the anchor: the anchor holdings at their anchor prices
  const anchorBySecurity = new Map<string, number>();
  let anchorTotal = cash;
  for (const [id, q] of shares) {
    if (q === 0) continue;
    const v = Math.round(q * (anchorPrice.get(id) ?? 0));
    anchorBySecurity.set(id, v);
    anchorTotal += v;
  }
  const anchorValue: DayValue = { totalCents: anchorTotal, cashCents: cash, bySecurity: anchorBySecurity, excluded: new Set() };

  // walk back day by day; before computing day d, undo every transaction dated after d
  const byDay = new Map<string, DayValue>();
  let i = txns.length - 1;
  for (let day = addDays(anchor, -1); day >= earliest; day = addDays(day, -1)) {
    for (; i >= 0 && txns[i]!.date > day; i -= 1) undo(txns[i]!);
    byDay.set(day, value(day));
  }
  // before the earliest transaction: everything recorded is undone, shares and cash hold, prices still move
  for (; i >= 0; i -= 1) undo(txns[i]!);
  return { accountId, anchor, earliest, valueOn: (day) => (day >= anchor ? anchorValue : byDay.get(day) ?? value(day)) };
}
