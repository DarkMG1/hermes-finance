import type { Holding, HoldingAccount, Investments, NetWorthHistory, NetWorthQuery } from '@hermes/shared';
import type { Db } from './db.ts';
import type { Deps } from './deps.ts';
import { addDays } from './days.ts';
import { localDay, MONTHS, minusMonths, nextDay } from './networth.ts';
import { PlaidError, type PlaidHoldings, type PlaidSecurity } from './plaid/port.ts';

const CONSENT = new Set(['ADDITIONAL_CONSENT_REQUIRED', 'ACCESS_NOT_GRANTED']);
const UNSUPPORTED = new Set(['PRODUCTS_NOT_SUPPORTED', 'NO_INVESTMENT_ACCOUNTS']);

const cents = (dollars: number): number => {
  const c = Math.round(dollars * 100);
  return c === 0 ? 0 : c; // avoid -0
};

/** Holdings of one ticker combine across accounts; every cash position is one "Cash" holding, keyed `_cash` (no ticker has an underscore). */
export function holdingKey(s: { securityId: string; ticker: string | null; type: string | null; isCash: number | boolean }): string {
  if (s.isCash === true || s.isCash === 1 || s.type === 'cash') return '_cash';
  return s.ticker ? s.ticker.toUpperCase() : s.securityId;
}

function upsertSecurities(db: Db, securities: PlaidSecurity[], nowIso: string): void {
  const upsertSecurity = db.prepare(`
    INSERT INTO securities (id, name, ticker, type, is_cash, close_price_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, ticker = excluded.ticker, type = excluded.type, is_cash = excluded.is_cash,
      close_price_cents = excluded.close_price_cents, updated_at = excluded.updated_at`);
  for (const s of securities) {
    upsertSecurity.run(s.securityId, s.name, s.ticker, s.type, s.isCash ? 1 : 0, s.closePrice === null ? null : cents(s.closePrice), nowIso);
  }
}

/** Stores the item's investment transactions: 730 days the first time, then the last 30 (Plaid corrects recent ones). Never throws. */
export async function syncInvestmentTransactions(deps: Deps, itemId: string, token: string, accountIds: Map<string, string>): Promise<void> {
  const { db } = deps;
  try {
    const ids = [...accountIds.values()];
    const stored = (db.prepare(`SELECT COUNT(*) AS n FROM investment_transactions WHERE account_id IN (${ids.map(() => '?').join(', ')})`)
      .get(...ids) as { n: number }).n;
    const today = localDay(deps.now());
    const data = await deps.plaid.investmentsTransactionsGet(token, addDays(today, stored > 0 ? -30 : -730), today);
    const nowIso = deps.now().toISOString();
    db.transaction(() => {
      upsertSecurities(db, data.securities, nowIso);
      const upsert = db.prepare(`
        INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, price_cents, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, security_id = excluded.security_id, date = excluded.date, type = excluded.type,
          subtype = excluded.subtype, quantity = excluded.quantity, amount_cents = excluded.amount_cents, price_cents = excluded.price_cents,
          updated_at = excluded.updated_at`);
      for (const t of data.transactions) {
        const accountId = accountIds.get(t.accountId);
        if (!accountId) continue;
        upsert.run(t.id, accountId, t.securityId, t.date, t.type, t.subtype, t.quantity, cents(t.amount), t.price === null ? null : cents(t.price), nowIso);
      }
    })();
  } catch (e) {
    const code = e instanceof PlaidError ? e.code : e instanceof Error ? e.message : String(e);
    console.error(`[hermes] investment transactions failed item=${itemId} ${code}`);
  }
}

/** Fetches the item's holdings and stores them with today's snapshot. Never throws: a failure must not fail the bank sync. */
export async function syncHoldings(deps: Deps, itemId: string, token: string): Promise<void> {
  const { db } = deps;
  try {
    const accounts = db.prepare("SELECT id, plaid_account_id AS plaidId FROM accounts WHERE item_id = ? AND type = 'investment'").all(itemId) as
      { id: string; plaidId: string }[];
    if (accounts.length === 0) return;
    let data: PlaidHoldings;
    try {
      data = await deps.plaid.investmentsHoldingsGet(token);
    } catch (e) {
      const code = e instanceof PlaidError ? e.code : 'HOLDINGS_FAILED';
      const status = CONSENT.has(code) ? 'consent_required' : UNSUPPORTED.has(code) ? 'not_supported' : null;
      if (status) db.prepare('UPDATE items SET investments_status = ? WHERE id = ?').run(status, itemId);
      console.error(`[hermes] holdings failed item=${itemId} code=${code}`);
      return;
    }
    const accountIds = new Map(accounts.map((a) => [a.plaidId, a.id]));
    const known = new Set(data.securities.map((s) => s.securityId));
    const nowIso = deps.now().toISOString();
    const day = localDay(deps.now());
    db.transaction(() => {
      upsertSecurities(db, data.securities, nowIso);
      // replace, so a position sold since the last sync disappears, from today's snapshot too
      for (const a of accounts) {
        db.prepare('DELETE FROM holdings WHERE account_id = ?').run(a.id);
        db.prepare('DELETE FROM holding_snapshots WHERE account_id = ? AND date = ?').run(a.id, day);
      }
      const insert = db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const snapshot = db.prepare('INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES (?, ?, ?, ?, ?)');
      // Plaid can report one security in one account more than once (lots): combine them
      type Row = { accountId: string; securityId: string; quantity: number; priceCents: number; valueCents: number; costCents: number | null };
      const combined = new Map<string, Row>();
      for (const h of data.holdings) {
        const accountId = accountIds.get(h.accountId);
        if (!accountId || !known.has(h.securityId)) continue;
        const costCents = h.costBasis === null ? null : cents(h.costBasis);
        const id = `${accountId}|${h.securityId}`;
        const prev = combined.get(id);
        if (!prev) {
          combined.set(id, { accountId, securityId: h.securityId, quantity: h.quantity, priceCents: cents(h.price), valueCents: cents(h.value), costCents });
          continue;
        }
        prev.quantity += h.quantity;
        prev.valueCents += cents(h.value);
        prev.costCents = prev.costCents === null || costCents === null ? null : prev.costCents + costCents;
        prev.priceCents = prev.quantity === 0 ? cents(h.price) : Math.round(prev.valueCents / prev.quantity) || 0;
      }
      for (const c of combined.values()) {
        insert.run(c.accountId, c.securityId, c.quantity, c.priceCents, c.valueCents, c.costCents, nowIso);
        snapshot.run(c.accountId, c.securityId, day, c.quantity, c.valueCents);
      }
      // marks the day synced even for an account left with no holdings, so its old values stop carrying forward
      const synced = db.prepare('INSERT OR IGNORE INTO holding_syncs (account_id, date) VALUES (?, ?)');
      for (const a of accounts) synced.run(a.id, day);
      db.prepare("UPDATE items SET investments_status = 'ok' WHERE id = ?").run(itemId);
    })();
    await syncInvestmentTransactions(deps, itemId, token, accountIds);
  } catch (e) {
    console.error(`[hermes] holdings store failed item=${itemId} ${e instanceof Error ? e.message : String(e)}`);
  }
}

type HoldingRow = {
  accountId: string; accountName: string; securityId: string; quantity: number; valueCents: number; costBasisCents: number | null;
  updatedAt: string; name: string | null; ticker: string | null; type: string | null; isCash: number;
};

/** Sums, or null when any is unknown. */
const sumKnown = (xs: (number | null)[]): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0);

export function getInvestments(db: Db): Investments {
  const rows = db.prepare(`
    SELECT h.account_id AS accountId, COALESCE(a.display_name, a.name) AS accountName, h.security_id AS securityId, h.quantity,
      h.value_cents AS valueCents, h.cost_basis_cents AS costBasisCents, h.updated_at AS updatedAt,
      s.name, s.ticker, s.type, s.is_cash AS isCash
    FROM holdings h JOIN accounts a ON a.id = h.account_id JOIN securities s ON s.id = h.security_id
    WHERE a.hidden = 0`).all() as HoldingRow[];
  const groups = new Map<string, HoldingRow[]>();
  for (const r of rows) {
    const key = holdingKey(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const holdings: Holding[] = [...groups].map(([key, members]) => {
    const cash = key === '_cash';
    // cash with no reported cost is worth what it cost
    const cost = (r: HoldingRow) => (r.costBasisCents === null && cash ? r.valueCents : r.costBasisCents);
    const top = members.reduce((a, b) => (b.valueCents > a.valueCents ? b : a));
    const quantity = members.reduce((a, r) => a + r.quantity, 0);
    const valueCents = members.reduce((a, r) => a + r.valueCents, 0);
    const costBasisCents = sumKnown(members.map(cost));
    const byAccount = new Map<string, HoldingRow[]>();
    for (const r of members) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
    const accounts: HoldingAccount[] = [...byAccount].map(([accountId, rs]) => ({
      accountId, accountName: rs[0]!.accountName, quantity: rs.reduce((a, r) => a + r.quantity, 0),
      valueCents: rs.reduce((a, r) => a + r.valueCents, 0), costBasisCents: sumKnown(rs.map(cost)),
    })).sort((a, b) => b.valueCents - a.valueCents);
    return {
      key, name: cash ? 'Cash' : top.name ?? top.ticker ?? key, ticker: cash ? null : top.ticker, type: cash ? 'cash' : top.type, quantity,
      priceCents: cash || quantity === 0 ? null : Math.round(valueCents / quantity), valueCents, costBasisCents,
      gainCents: costBasisCents === null ? null : valueCents - costBasisCents, accounts,
    };
  }).sort((a, b) => b.valueCents - a.valueCents || a.key.localeCompare(b.key));
  const costBasisCents = holdings.length === 0 ? null : sumKnown(holdings.map((h) => h.costBasisCents));
  const totalCents = holdings.reduce((a, h) => a + h.valueCents, 0);
  const asOf = rows.reduce<string | null>((a, r) => (a === null || r.updatedAt > a ? r.updatedAt : a), null);
  const reconnect = (db.prepare("SELECT id, institution_name FROM items WHERE investments_status = 'consent_required' ORDER BY institution_name").all() as
    { id: string; institution_name: string }[]).map((i) => ({ itemId: i.id, institutionName: i.institution_name }));
  return { totalCents, costBasisCents, gainCents: costBasisCents === null ? null : totalCents - costBasisCents, asOf, holdings, reconnect };
}

/**
 * One holding's value per day, summed over accounts. A day an account synced holdings (holding_syncs) without this holding
 * counts it 0 (sold); a day it didn't sync carries its last value forward. Null when the holding has no snapshots.
 */
export function getHoldingHistory(db: Db, key: string, range: NetWorthQuery['range'], today: string): NetWorthHistory | null {
  const all = db.prepare(`
    SELECT hs.account_id AS accountId, hs.security_id AS securityId, hs.date, hs.value_cents AS cents, s.ticker, s.type, s.is_cash AS isCash
    FROM holding_snapshots hs JOIN accounts a ON a.id = hs.account_id JOIN securities s ON s.id = hs.security_id
    WHERE a.hidden = 0 AND hs.date <= ? ORDER BY hs.date`).all(today) as
    { accountId: string; securityId: string; date: string; cents: number; ticker: string | null; type: string | null; isCash: number }[];
  const mine = all.filter((r) => holdingKey(r) === key);
  const first = mine[0];
  if (!first) return null;
  const synced = new Set((db.prepare(`
    SELECT hs.account_id AS accountId, hs.date FROM holding_syncs hs JOIN accounts a ON a.id = hs.account_id WHERE a.hidden = 0 AND hs.date <= ?`)
    .all(today) as { accountId: string; date: string }[]).map((r) => `${r.accountId}|${r.date}`));
  const accounts = [...new Set(mine.map((r) => r.accountId))];
  const values = new Map<string, number>();
  for (const r of mine) values.set(`${r.accountId}|${r.date}`, (values.get(`${r.accountId}|${r.date}`) ?? 0) + r.cents);
  const wanted = range === 'all' ? first.date : minusMonths(today, MONTHS[range]);
  const start = wanted > first.date ? wanted : first.date;
  const latest = new Map<string, number>();
  const points: NetWorthHistory['points'] = [];
  for (let day = first.date; day <= today; day = nextDay(day)) {
    for (const a of accounts) if (synced.has(`${a}|${day}`)) latest.set(a, values.get(`${a}|${day}`) ?? 0);
    if (day >= start) points.push({ date: day, netWorthCents: [...latest.values()].reduce((x, y) => x + y, 0) });
  }
  const last = points[points.length - 1]!;
  return { points, currentCents: last.netWorthCents, changeCents: last.netWorthCents - points[0]!.netWorthCents, estimatedThrough: null };
}
