import { PlaidError, type LinkResult, type LinkTokenOpts, type PlaidAccount, type PlaidHoldings, type PlaidPort, type PlaidRecurringStream, type PlaidTxn, type SyncPage } from '../src/plaid/port.ts';

export function txn(over: Partial<PlaidTxn> & { transactionId: string }): PlaidTxn {
  return {
    accountId: 'pa1', amount: 10, date: '2026-03-10', authorizedDate: null, name: 'SYNTHETIC SHOP 123',
    merchantName: 'Synthetic Shop', pending: false, pendingTransactionId: null, category: 'FOOD_AND_DRINK_COFFEE',
    ...over,
  };
}

// Each queueSync() call is one complete sync run: a list of pages served in order.
export class FakePlaid implements PlaidPort {
  runs: SyncPage[][] = [];
  accounts: PlaidAccount[] = [{ accountId: 'pa1', name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', currentBalance: 100, availableBalance: 100 }];
  linkResults = new Map<string, LinkResult>();
  exchanged: string[] = [];
  syncCalls: (string | null)[] = [];
  holdings: PlaidHoldings = { holdings: [], securities: [] };
  investmentTxns: Awaited<ReturnType<PlaidPort['investmentsTransactionsGet']>> = { accountIds: [], transactions: [], securities: [] };
  investmentTxnCalls: [string, string][] = [];
  private investmentTxnFailures: string[] = [];
  recurring: PlaidRecurringStream[] = [];
  private recurringFailures: string[] = [];
  holdingsCalls = 0;
  linkOpts: LinkTokenOpts[] = [];
  private holdingsFailures: string[] = [];
  private pageIndex = 0;
  private failures: string[] = [];
  private linkCounter = 0;

  queueSync(pages: SyncPage[]): void { this.runs.push(pages); }
  failNextSync(code: string): void { this.failures.push(code); }

  async transactionsSync(_accessToken: string, cursor: string | null): Promise<SyncPage> {
    this.syncCalls.push(cursor);
    const failure = this.failures.shift();
    if (failure) { this.pageIndex = 0; throw new PlaidError(failure); }
    const run = this.runs[0];
    if (!run) return { added: [], modified: [], removed: [], nextCursor: cursor ?? 'c0', hasMore: false };
    const page = run[this.pageIndex];
    if (!page) throw new Error('fake: no page queued');
    this.pageIndex += 1;
    if (!page.hasMore) { this.runs.shift(); this.pageIndex = 0; }
    return page;
  }

  failNextInvestmentTxns(code: string): void { this.investmentTxnFailures.push(code); }

  async investmentsTransactionsGet(_token: string, startDate: string, endDate: string) {
    this.investmentTxnCalls.push([startDate, endDate]);
    const failure = this.investmentTxnFailures.shift();
    if (failure) throw new PlaidError(failure);
    return this.investmentTxns;
  }

  failNextRecurring(code: string): void { this.recurringFailures.push(code); }

  async recurringGet(): Promise<PlaidRecurringStream[]> {
    const failure = this.recurringFailures.shift();
    if (failure) throw new PlaidError(failure);
    return this.recurring;
  }

  failNextHoldings(code: string): void { this.holdingsFailures.push(code); }

  async investmentsHoldingsGet(): Promise<PlaidHoldings> {
    this.holdingsCalls += 1;
    const failure = this.holdingsFailures.shift();
    if (failure) throw new PlaidError(failure);
    return this.holdings;
  }

  async accountsGet(): Promise<PlaidAccount[]> { return this.accounts; }

  async createLinkToken(opts: LinkTokenOpts) {
    this.linkOpts.push(opts);
    this.linkCounter += 1;
    const linkToken = `link-${opts.mode}-${this.linkCounter}`;
    return { linkToken, hostedLinkUrl: `https://hosted.plaid.test/${linkToken}`, expiration: '2099-01-01T00:00:00Z' };
  }

  async getLinkResult(linkToken: string): Promise<LinkResult> { return this.linkResults.get(linkToken) ?? { status: 'pending' }; }

  async exchangePublicToken(publicToken: string) {
    this.exchanged.push(publicToken);
    return { accessToken: `access-${publicToken}`, itemId: `plaid-item-${publicToken}` };
  }
}
