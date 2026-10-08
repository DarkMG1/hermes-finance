import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ActualAccount = { id: string; name: string; offbudget: boolean; closed: boolean };
export type ActualCategory = { id: string; name: string; groupName: string; isIncome: boolean; hidden: boolean };
export type ActualLine = { amountCents: number; categoryId: string | null; notes: string | null; isTransfer: boolean };
export type ActualTxn = {
  id: string; accountId: string; date: string; amountCents: number; categoryId: string | null;
  payee: string | null; importedPayee: string | null; notes: string | null; isTransfer: boolean; lines: ActualLine[];
};
export type ActualSnapshot = { accounts: ActualAccount[]; categories: ActualCategory[]; transactions: ActualTxn[] };

type RawTxn = {
  id: string; account: string; date: string; amount: number; category?: string | null; payee?: string | null;
  imported_payee?: string | null; notes?: string | null; transfer_id?: string | null; is_parent?: boolean; is_child?: boolean;
  parent_id?: string | null; tombstone?: boolean; subtransactions?: RawTxn[];
};

// The subset of @actual-app/api the migration reads. Nothing here mutates the budget.
export type ActualApi = {
  getAccounts(): Promise<{ id: string; name: string; offbudget?: boolean; closed?: boolean }[]>;
  getCategoryGroups(): Promise<{ id: string; name: string; is_income?: boolean; hidden?: boolean;
    categories?: { id: string; name: string; is_income?: boolean; hidden?: boolean }[] }[]>;
  getPayees(): Promise<{ id: string; name: string; transfer_acct?: string | null }[]>;
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<RawTxn[]>;
};

function cents(r: RawTxn): number {
  if (!Number.isInteger(r.amount)) throw new Error(`non-integer amount on ${r.id}`);
  return r.amount;
}

export async function readSnapshot(api: ActualApi): Promise<ActualSnapshot> {
  const accounts = (await api.getAccounts()).map((a) => ({ id: a.id, name: a.name, offbudget: Boolean(a.offbudget), closed: Boolean(a.closed) }));
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categories = (await api.getCategoryGroups()).flatMap((g) => (g.categories ?? []).map((c) => ({
    id: c.id, name: c.name, groupName: g.name, isIncome: Boolean(g.is_income || c.is_income), hidden: Boolean(g.hidden || c.hidden),
  })));
  const payees = new Map((await api.getPayees()).map((p) => [p.id, p.name || (p.transfer_acct ? accountName.get(p.transfer_acct) ?? null : null)]));

  const transactions: ActualTxn[] = [];
  for (const a of accounts) {
    const rows = (await api.getTransactions(a.id, '1900-01-01', '2999-12-31')).filter((r) => !r.tombstone);
    const children = new Map<string, RawTxn[]>();
    for (const r of rows) if (r.is_child && r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
    for (const r of rows) {
      if (r.is_child) continue;
      const subs = (r.subtransactions?.length ? r.subtransactions : children.get(r.id) ?? []).filter((s) => !s.tombstone);
      transactions.push({
        id: r.id, accountId: a.id, date: r.date, amountCents: cents(r),
        categoryId: subs.length ? null : r.category ?? null,
        payee: r.payee ? payees.get(r.payee) ?? null : null,
        importedPayee: r.imported_payee ?? null, notes: r.notes ?? null, isTransfer: Boolean(r.transfer_id),
        lines: subs.map((s) => ({ amountCents: cents(s), categoryId: s.category ?? null, notes: s.notes ?? null, isTransfer: Boolean(s.transfer_id) })),
      });
    }
  }
  return { accounts, categories, transactions };
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

type ActualModule = ActualApi & {
  init(config: { dataDir: string; serverURL: string; password: string }): Promise<unknown>;
  downloadBudget(syncId: string): Promise<void>;
  shutdown(): Promise<void>;
};

// Downloads the budget into a throwaway cache dir, reads it, and deletes the cache.
export async function loadActualSnapshot(env: NodeJS.ProcessEnv): Promise<ActualSnapshot> {
  const api = createRequire(import.meta.url)('@actual-app/api') as ActualModule;
  const dataDir = mkdtempSync(join(tmpdir(), 'hermes-actual-'));
  try {
    await api.init({ dataDir, serverURL: need(env, 'ACTUAL_SERVER_URL'), password: need(env, 'ACTUAL_PASSWORD') });
    await api.downloadBudget(need(env, 'ACTUAL_SYNC_ID'));
    return await readSnapshot(api);
  } finally {
    await api.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}
