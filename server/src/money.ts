import { MAX_AMOUNT_CENTS } from '@hermes/shared';
import { ApiError } from './errors.ts';

// Plaid: positive = money out. Hermes: negative = money out, integer cents.
export function plaidAmountToCents(amount: number): number {
  const cents = -Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_AMOUNT_CENTS) throw new ApiError(400, 'INVALID_REQUEST', 'amount must be at most 10,000,000.00', 'amount');
  return cents === 0 ? 0 : cents; // avoid -0
}
