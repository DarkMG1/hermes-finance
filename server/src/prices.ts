import type { Deps } from './deps.ts';
import { addDays, localDay } from './days.ts';
import { PRICED_TYPES } from './backfill.ts';
import { PriceError, type DailyPrice } from './prices/port.ts';

export { PriceError, type DailyPrice, type PricePort } from './prices/port.ts';

/** Tiingo writes share classes with a dash: BRK.B → BRK-B. */
export const tiingoTicker = (ticker: string): string => ticker.toUpperCase().replace(/\./g, '-');

/** Fetches each held or traded ticker's missing daily closes. Never throws: prices are best effort. */
export async function syncPrices(deps: Deps): Promise<void> {
  const { db, prices } = deps;
  if (!prices) return;
  try {
    const today = localDay(deps.now());
    const tickers = (db.prepare(`
      SELECT DISTINCT UPPER(s.ticker) AS ticker FROM securities s
      WHERE s.ticker IS NOT NULL AND s.is_cash = 0 AND s.type IN (${PRICED_TYPES.map(() => '?').join(', ')})
        AND (s.id IN (SELECT security_id FROM holdings) OR s.id IN (SELECT security_id FROM investment_transactions WHERE security_id IS NOT NULL))
      ORDER BY 1`).all(...PRICED_TYPES) as { ticker: string }[]).map((r) => r.ticker);
    const latest = db.prepare('SELECT MAX(date) AS d FROM security_prices WHERE ticker = ?');
    const insert = db.prepare('INSERT OR REPLACE INTO security_prices (ticker, date, close_cents, split_factor) VALUES (?, ?, ?, ?)');
    for (const ticker of tickers) {
      const last = (latest.get(ticker) as { d: string | null }).d;
      // from the latest stored day, not after it: that close may have been provisional
      const from = last ?? addDays(today, -730);
      if (from > today) continue;
      let rows: DailyPrice[];
      try {
        rows = await prices.dailyPrices(ticker, from, today);
      } catch (e) {
        const code = e instanceof PriceError ? e.code : 'PRICES_FAILED';
        console.error(`[hermes] prices failed code=${code}`);
        if (code === 'NOT_FOUND') continue;
        return;
      }
      db.transaction(() => {
        for (const r of rows) insert.run(ticker, r.date, Math.round(r.close * 100), r.splitFactor || 1);
      })();
    }
  } catch {
    console.error('[hermes] prices store failed');
  }
}
