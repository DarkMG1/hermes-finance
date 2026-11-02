import type { z } from 'zod';
import { ApiError } from './errors.ts';

export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : undefined;
  throw new ApiError(400, 'INVALID_REQUEST', issue ? `${field ?? 'request'}: ${issue.message}` : 'invalid request', field);
}

/** Owner-entered dates run from 2000-01-01 to a year after the owner's today (`localDay`); bank dates and filters are never bounded. */
export function assertOwnerDate(date: string | null | undefined, today: string): void {
  if (date && (date < '2000-01-01' || date > `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'date: must be from 2000-01-01 to a year from today', 'date');
  }
}
