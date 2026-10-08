import type { z } from 'zod';
import { ApiError } from './errors.ts';

export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : undefined;
  throw new ApiError(400, 'INVALID_REQUEST', issue ? `${field ?? 'request'}: ${issue.message}` : 'invalid request', field);
}
