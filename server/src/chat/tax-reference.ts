import { readFileSync } from 'node:fs';
import { federalFigures, federalYears, SOURCES, StateModel } from '../tax/figures.ts';

// What Ask's tax_reference tool returns: the year's published federal figures and, when the server's state file has the year, its state
// entries that parse (a malformed one is left out, as the calculator leaves it out).
export function taxReference(year: number, stateFile: string | null) {
  if (!federalYears().includes(year)) return { year, available: federalYears(), note: `no ${year} figures in Hermes yet` };
  let states: Record<string, StateModel> | undefined;
  try {
    const raw = stateFile ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, Record<string, unknown> | undefined>)[String(year)] : undefined;
    states = Object.fromEntries(Object.entries(raw ?? {}).flatMap(([code, v]) => { const p = StateModel.safeParse(v); return p.success ? [[code, p.data]] : []; }));
  } catch { states = undefined; }
  return { year, federal: federalFigures(year).figures, sources: SOURCES, ...(states && Object.keys(states).length ? { states } : {}) };
}
