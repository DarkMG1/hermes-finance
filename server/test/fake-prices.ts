import { PriceError, type DailyPrice, type PricePort } from '../src/prices.ts';

export class FakePrices implements PricePort {
  series = new Map<string, DailyPrice[]>();
  calls: [string, string, string][] = [];
  failWith = new Map<string, string>();

  async dailyPrices(ticker: string, from: string, to: string): Promise<DailyPrice[]> {
    this.calls.push([ticker, from, to]);
    const failure = this.failWith.get(ticker);
    if (failure) throw new PriceError(failure);
    return (this.series.get(ticker) ?? []).filter((p) => p.date >= from && p.date <= to);
  }
}
