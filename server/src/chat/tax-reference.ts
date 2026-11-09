import { readFileSync } from 'node:fs';
import { federalFigures, federalYears, SOURCES } from '../tax/figures.ts';

// What Ask's tax_reference tool returns: the year's published federal figures and, when the server's state file has the year, its raw state entries.
export function taxReference(year: number, stateFile: string | null) {
  if (!federalYears().includes(year)) return { year, available: federalYears(), note: `no ${year} figures in Hermes yet` };
  let states: unknown;
  try { states = stateFile ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>)[String(year)] : undefined; } catch { states = undefined; }
  return { year, federal: federalFigures(year).figures, sources: SOURCES, ...(states ? { states } : {}) };
}
