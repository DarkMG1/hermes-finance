import { PriceError, tiingoTicker, type DailyPrice, type PricePort } from '../prices.ts';

export function createTiingoClient(apiKey: string): PricePort {
  return {
    async dailyPrices(ticker, from, to): Promise<DailyPrice[]> {
      const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(tiingoTicker(ticker))}/prices?startDate=${from}&endDate=${to}`;
      const res = await fetch(url, { headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404 || res.status === 400) throw new PriceError('NOT_FOUND');
      if (!res.ok) throw new PriceError(`HTTP_${res.status}`);
      const rows = (await res.json()) as { date: string; close: number; splitFactor?: number }[];
      return rows.map((r) => ({ date: r.date.slice(0, 10), close: r.close, splitFactor: r.splitFactor ?? 1 }));
    },
  };
}
