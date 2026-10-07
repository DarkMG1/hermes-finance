export type PlaidTxn = {
  transactionId: string; accountId: string; amount: number; date: string; authorizedDate: string | null;
  name: string; merchantName: string | null; pending: boolean; pendingTransactionId: string | null; category: string | null;
};
export type SyncPage = { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transactionId: string }[]; nextCursor: string; hasMore: boolean };
export type PlaidAccount = {
  accountId: string; name: string; mask: string | null; type: string; subtype: string | null;
  currentBalance: number | null; availableBalance: number | null;
};
export type LinkResult =
  | { status: 'pending' }
  | { status: 'exited' }
  | { status: 'complete'; publicToken: string | null; institutionName: string | null };

export interface PlaidPort {
  transactionsSync(accessToken: string, cursor: string | null): Promise<SyncPage>;
  accountsGet(accessToken: string): Promise<PlaidAccount[]>;
  createLinkToken(opts: { mode: 'create' } | { mode: 'update'; accessToken: string }): Promise<{ linkToken: string; hostedLinkUrl: string; expiration: string }>;
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
