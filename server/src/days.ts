import type { SpendingQuery } from '@hermes/shared';

/** The owner's day: the date in the process time zone (the TZ env var). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A yyyy-MM-dd day moved by n calendar days. */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

export function periodRange(q: SpendingQuery): { from: string; toExclusive: string } {
  if (q.period === 'year') {
    return { from: `${q.date}-01-01`, toExclusive: `${String(Number(q.date) + 1).padStart(4, '0')}-01-01` };
  }
  const [ys, ms] = q.date.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const next = m === 12 ? `${String(y + 1).padStart(4, '0')}-01` : `${ys}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${q.date}-01`, toExclusive: `${next}-01` };
}
