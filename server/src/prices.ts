import type { Deps } from './deps.ts';
import { addDays } from './days.ts';
import { localDay, nextDay } from './networth.ts';

export type DailyPrice = { date: string; close: number; splitFactor: number };
export interface PricePort { dailyPrices(ticker: string, from: string, to: string): Promise<DailyPrice[]> }
export class PriceError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'PriceError'; this.code = code; }
}

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
      WHERE s.ticker IS NOT NULL AND s.is_cash = 0 AND COALESCE(s.type, '') <> 'cash'
        AND (s.id IN (SELECT security_id FROM holdings) OR s.id IN (SELECT security_id FROM investment_transactions WHERE security_id IS NOT NULL))
      ORDER BY 1`).all() as { ticker: string }[]).map((r) => r.ticker);
    const latest = db.prepare('SELECT MAX(date) AS d FROM security_prices WHERE ticker = ?');
    const insert = db.prepare('INSERT OR REPLACE INTO security_prices (ticker, date, close_cents, split_factor) VALUES (?, ?, ?, ?)');
    for (const ticker of tickers) {
      const last = (latest.get(ticker) as { d: string | null }).d;
      const from = last ? nextDay(last) : addDays(today, -730);
      if (from > today) continue;
      let rows: DailyPrice[];
      try {
        rows = await prices.dailyPrices(ticker, from, today);
      } catch (e) {
        const code = e instanceof PriceError ? e.code : 'PRICES_FAILED';
        console.error(`[hermes] prices failed ticker=${ticker} code=${code}`);
        if (code === 'NOT_FOUND') continue;
        return;
      }
      db.transaction(() => {
        for (const r of rows) insert.run(ticker, r.date, Math.round(r.close * 100), r.splitFactor || 1);
      })();
    }
  } catch (e) {
    console.error(`[hermes] prices store failed ${e instanceof Error ? e.message : String(e)}`);
  }
}
