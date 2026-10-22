export type DailyPrice = { date: string; close: number; splitFactor: number };
export interface PricePort { dailyPrices(ticker: string, from: string, to: string): Promise<DailyPrice[]> }
export class PriceError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'PriceError'; this.code = code; }
}
