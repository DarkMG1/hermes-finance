import type { ActualSnapshot } from './actual.ts';
import { MigrationError, type AccountMapping } from './import.ts';

export type MappingFile = {
  accounts: Record<string, { to: string; cutover?: string; name?: string; closed?: boolean; offbudget?: boolean }>;
  hermesAccounts?: Record<string, string>;
};

export function parseMapping(text: string): { mapping: AccountMapping; cutovers: Record<string, string> } {
  const accounts = (JSON.parse(text) as { accounts?: unknown } | null)?.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw new MigrationError('mapping file needs an "accounts" object');
  const mapping: AccountMapping = {};
  const cutovers: Record<string, string> = {};
  for (const [id, entry] of Object.entries(accounts)) {
    const { to, cutover } = (entry ?? {}) as { to?: unknown; cutover?: unknown };
    if (typeof to !== 'string' || to === '') throw new MigrationError(`mapping for Actual account ${id} needs "to": a Hermes account id, "new" or "skip"`);
    mapping[id] = to;
    if (cutover === undefined) continue;
    if (typeof cutover !== 'string') throw new MigrationError(`mapping for Actual account ${id} has a "cutover" that is not a YYYY-MM-DD string`);
    cutovers[id] = cutover;
  }
  return { mapping, cutovers };
}

export function mappingSkeleton(snapshot: ActualSnapshot, hermes: { id: string; name: string; mask: string | null; type: string }[]): MappingFile {
  return {
    accounts: Object.fromEntries(snapshot.accounts.map((a) => [a.id, { to: '', name: a.name, closed: a.closed, offbudget: a.offbudget }])),
    hermesAccounts: Object.fromEntries(hermes.map((h) => [h.id, `${h.name}${h.mask ? ` ••${h.mask}` : ''} (${h.type})`])),
  };
}
