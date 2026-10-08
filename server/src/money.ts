// Plaid: positive = money out. Hermes: negative = money out, integer cents.
export function plaidAmountToCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error('non-finite amount');
  const cents = -Math.round(amount * 100);
  return cents === 0 ? 0 : cents; // avoid -0
}
