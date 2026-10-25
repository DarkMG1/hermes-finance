export type PlaidTxn = {
  transactionId: string; accountId: string; amount: number; date: string; authorizedDate: string | null;
  name: string; merchantName: string | null; pending: boolean; pendingTransactionId: string | null; category: string | null;
};
export type SyncPage = { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transactionId: string }[]; nextCursor: string; hasMore: boolean };
export type PlaidAccount = {
  accountId: string; name: string; mask: string | null; type: string; subtype: string | null;
  currentBalance: number | null; availableBalance: number | null;
};
/** Amounts in dollars, as Plaid sends them (positive values). */
type PlaidHolding = { accountId: string; securityId: string; quantity: number; price: number; value: number; costBasis: number | null };
export type PlaidSecurity = { securityId: string; name: string | null; ticker: string | null; type: string | null; isCash: boolean; closePrice: number | null };
/** Plaid signs: quantity positive for buys, negative for sells; amount positive when cash is debited. Dollars. */
export type PlaidInvestmentTxn = {
  id: string; accountId: string; securityId: string | null; date: string; type: string; subtype: string | null;
  quantity: number; amount: number; price: number | null;
};
export type PlaidHoldings = { holdings: PlaidHolding[]; securities: PlaidSecurity[] };
/** Outflow streams only; dollars, positive. */
export type PlaidRecurringStream = {
  streamId: string; name: string; frequency: string; averageAmount: number; lastAmount: number; lastDate: string;
  nextDate: string | null; isActive: boolean; status: string; category: string | null; transactionIds: string[];
};
export type LinkTokenOpts = { mode: 'create' } | { mode: 'update'; accessToken: string; addInvestments?: boolean };
export type LinkResult =
  | { status: 'pending' }
  | { status: 'exited' }
  | { status: 'complete'; publicToken: string | null; institutionName: string | null };

export interface PlaidPort {
  transactionsSync(accessToken: string, cursor: string | null): Promise<SyncPage>;
  accountsGet(accessToken: string): Promise<PlaidAccount[]>;
  recurringGet(accessToken: string): Promise<PlaidRecurringStream[]>;
  investmentsHoldingsGet(accessToken: string): Promise<PlaidHoldings>;
  investmentsTransactionsGet(accessToken: string, startDate: string, endDate: string): Promise<{ accountIds: string[]; transactions: PlaidInvestmentTxn[]; securities: PlaidSecurity[] }>;
  createLinkToken(opts: LinkTokenOpts): Promise<{ linkToken: string; hostedLinkUrl: string; expiration: string }>;
  getLinkResult(linkToken: string): Promise<LinkResult>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
}

export class PlaidError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'PlaidError';
    this.code = code;
  }
}
