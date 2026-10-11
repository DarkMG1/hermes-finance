import type { Deps } from './deps.ts';
import { localDay } from './networth.ts';
import { PlaidError, type PlaidHoldings } from './plaid/port.ts';

const CONSENT = new Set(['ADDITIONAL_CONSENT_REQUIRED', 'ACCESS_NOT_GRANTED']);
const UNSUPPORTED = new Set(['PRODUCTS_NOT_SUPPORTED', 'NO_INVESTMENT_ACCOUNTS']);

const cents = (dollars: number): number => {
  const c = Math.round(dollars * 100);
  return c === 0 ? 0 : c; // avoid -0
};

/** Holdings of one ticker combine across accounts; every cash position is one "Cash" holding. */
export function holdingKey(s: { securityId: string; ticker: string | null; type: string | null; isCash: number | boolean }): string {
  if (s.isCash === true || s.isCash === 1 || s.type === 'cash') return 'CASH';
  return s.ticker ? s.ticker.toUpperCase() : s.securityId;
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
      const upsertSecurity = db.prepare(`
        INSERT INTO securities (id, name, ticker, type, is_cash, close_price_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, ticker = excluded.ticker, type = excluded.type, is_cash = excluded.is_cash,
          close_price_cents = excluded.close_price_cents, updated_at = excluded.updated_at`);
      for (const s of data.securities) {
        upsertSecurity.run(s.securityId, s.name, s.ticker, s.type, s.isCash ? 1 : 0, s.closePrice === null ? null : cents(s.closePrice), nowIso);
      }
      // replace, so a position sold since the last sync disappears, from today's snapshot too
      for (const a of accounts) {
        db.prepare('DELETE FROM holdings WHERE account_id = ?').run(a.id);
        db.prepare('DELETE FROM holding_snapshots WHERE account_id = ? AND date = ?').run(a.id, day);
      }
      const insert = db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const snapshot = db.prepare('INSERT INTO holding_snapshots (account_id, security_id, date, quantity, value_cents) VALUES (?, ?, ?, ?, ?)');
      for (const h of data.holdings) {
        const accountId = accountIds.get(h.accountId);
        if (!accountId || !known.has(h.securityId)) continue;
        insert.run(accountId, h.securityId, h.quantity, cents(h.price), cents(h.value), h.costBasis === null ? null : cents(h.costBasis), nowIso);
        snapshot.run(accountId, h.securityId, day, h.quantity, cents(h.value));
      }
      db.prepare("UPDATE items SET investments_status = 'ok' WHERE id = ?").run(itemId);
    })();
  } catch (e) {
    console.error(`[hermes] holdings store failed item=${itemId} ${e instanceof Error ? e.message : String(e)}`);
  }
}
