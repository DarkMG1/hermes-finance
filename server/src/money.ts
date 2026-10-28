import { ApiError } from './errors.ts';

// Plaid: positive = money out. Hermes: negative = money out, integer cents.
export function plaidAmountToCents(amount: number): number {
  const cents = -Math.round(amount * 100);
  // bank data is trusted: one huge Plaid row must not fail the whole sync (split math guards its own loop)
  if (!Number.isSafeInteger(cents)) throw new ApiError(400, 'INVALID_REQUEST', 'amount is not a valid number', 'amount');
  return cents === 0 ? 0 : cents; // avoid -0
}
