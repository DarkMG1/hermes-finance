import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products, type LinkTokenCreateRequest, type LinkTokenGetSessionsResponse } from 'plaid';
import type { Config } from '../config.ts';
import { PlaidError, type LinkResult, type PlaidAccount, type PlaidPort, type PlaidTxn, type SyncPage } from './port.ts';

const REDIRECT = 'hermesfinance://plaid-done';

function rethrow(e: unknown): never {
  const data = (e as { response?: { data?: { error_code?: string } } }).response?.data;
  throw new PlaidError(data?.error_code ?? 'PLAID_REQUEST_FAILED');
}

type RawTxn = {
  transaction_id: string; account_id: string; amount: number; date: string; authorized_date?: string | null; name: string;
  merchant_name?: string | null; pending: boolean; pending_transaction_id?: string | null;
  personal_finance_category?: { primary: string; detailed: string } | null;
};

function mapTxn(t: RawTxn): PlaidTxn {
  return {
    transactionId: t.transaction_id, accountId: t.account_id, amount: t.amount, date: t.date,
    authorizedDate: t.authorized_date ?? null, name: t.name, merchantName: t.merchant_name ?? null, pending: t.pending,
    pendingTransactionId: t.pending_transaction_id ?? null, category: t.personal_finance_category?.detailed ?? null,
  };
}

// A link token can carry several sessions (e.g. an exit then a retry that succeeded); look at all of them.
export function mapLinkSessions(sessions: LinkTokenGetSessionsResponse[]): LinkResult {
  for (const s of sessions) {
    const add = s.results?.item_add_results?.[0];
    if (add) return { status: 'complete', publicToken: add.public_token, institutionName: add.institution?.name ?? null };
    if (s.on_success) return { status: 'complete', publicToken: s.on_success.public_token ?? null, institutionName: s.on_success.metadata?.institution?.name ?? null };
  }
  if (sessions.length === 0 || sessions.some((s) => !s.finished_at)) return { status: 'pending' };
  // a finished session with neither results nor exit is update mode
  return sessions.every((s) => s.exit) ? { status: 'exited' } : { status: 'complete', publicToken: null, institutionName: null };
}

export function createPlaidClient(config: Config): PlaidPort {
  const api = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[config.plaid.env],
    baseOptions: { timeout: 30_000, headers: { 'PLAID-CLIENT-ID': config.plaid.clientId, 'PLAID-SECRET': config.plaid.secret } },
  }));

  return {
    async transactionsSync(accessToken, cursor): Promise<SyncPage> {
      try {
        const { data } = await api.transactionsSync({ access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 });
        return {
          added: data.added.map((t) => mapTxn(t as RawTxn)), modified: data.modified.map((t) => mapTxn(t as RawTxn)),
          removed: data.removed.map((r) => ({ transactionId: r.transaction_id })), nextCursor: data.next_cursor, hasMore: data.has_more,
        };
      } catch (e) { return rethrow(e); }
    },

    async accountsGet(accessToken): Promise<PlaidAccount[]> {
      try {
        const { data } = await api.accountsGet({ access_token: accessToken });
        return data.accounts.map((a) => ({
          accountId: a.account_id, name: a.name, mask: a.mask ?? null, type: String(a.type), subtype: a.subtype ? String(a.subtype) : null,
          currentBalance: a.balances.current ?? null, availableBalance: a.balances.available ?? null,
        }));
      } catch (e) { return rethrow(e); }
    },

    async createLinkToken(opts) {
      const req: LinkTokenCreateRequest = {
        user: { client_user_id: 'owner' }, client_name: 'Hermes', country_codes: [CountryCode.Us], language: 'en',
        hosted_link: { completion_redirect_uri: REDIRECT },
        ...(opts.mode === 'update'
          ? { access_token: opts.accessToken }
          : { products: [Products.Transactions], transactions: { days_requested: 730 } }),
      };
      try {
        const { data } = await api.linkTokenCreate(req);
        if (!data.hosted_link_url) throw new PlaidError('NO_HOSTED_LINK_URL');
        return { linkToken: data.link_token, hostedLinkUrl: data.hosted_link_url, expiration: data.expiration };
      } catch (e) { return e instanceof PlaidError ? Promise.reject(e) : rethrow(e); }
    },

    async getLinkResult(linkToken): Promise<LinkResult> {
      try {
        const { data } = await api.linkTokenGet({ link_token: linkToken });
        return mapLinkSessions(data.link_sessions ?? []);
      } catch (e) { return rethrow(e); }
    },

    async exchangePublicToken(publicToken) {
      try {
        const { data } = await api.itemPublicTokenExchange({ public_token: publicToken });
        return { accessToken: data.access_token, itemId: data.item_id };
      } catch (e) { return rethrow(e); }
    },
  };
}
