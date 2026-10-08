import type { ActualSnapshot } from './actual.ts';
import { MigrationError, type AccountMapping } from './import.ts';

export type MappingFile = {
  accounts: Record<string, { to: string; name?: string; closed?: boolean; offbudget?: boolean }>;
  hermesAccounts?: Record<string, string>;
};

export function parseMapping(text: string): AccountMapping {
  const accounts = (JSON.parse(text) as { accounts?: unknown } | null)?.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw new MigrationError('mapping file needs an "accounts" object');
  const out: AccountMapping = {};
  for (const [id, entry] of Object.entries(accounts)) {
    const to = (entry as { to?: unknown } | null)?.to;
    if (typeof to !== 'string' || to === '') throw new MigrationError(`mapping for Actual account ${id} needs "to": a Hermes account id, "new" or "skip"`);
    out[id] = to;
  }
  return out;
}

export function mappingSkeleton(snapshot: ActualSnapshot, hermes: { id: string; name: string; mask: string | null; type: string }[]): MappingFile {
  return {
    accounts: Object.fromEntries(snapshot.accounts.map((a) => [a.id, { to: '', name: a.name, closed: a.closed, offbudget: a.offbudget }])),
    hermesAccounts: Object.fromEntries(hermes.map((h) => [h.id, `${h.name}${h.mask ? ` ••${h.mask}` : ''} (${h.type})`])),
  };
}
