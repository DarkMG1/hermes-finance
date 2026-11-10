import type { StateModel } from './figures.ts';
import { bracketTax } from './federal.ts';
import type { Line, ReturnResult } from './types.ts';

/** Periods of residence in the year (inclusive dates), each naming the state lived in. */
export type Residency = { code: string; from: string; to: string }[];
export type StateInput = {
  code: string; residency: Residency;
  /** Income items by date received; `sourceState` is where it was earned (null: no particular state). */
  incomeByPeriod: { wagesCents: number; investmentCents: number; sourceState: string | null; date: string }[];
  totalIncomeCents: number; claimable: boolean; withheldCents: number; otherStateTaxCents: number;
  /** Where the withholding came from and what was assumed to get it (default: pay stubs, nothing assumed). */
  withheldSource?: string; withheldAssumption?: string;
};

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export function computeState(input: StateInput, model: StateModel | null): ReturnResult {
  const { code, withheldCents } = input;
  if (!model) {
    // its tax is unknown, so no balance: withholding alone would read as a refund
    return { jurisdiction: code, supported: false, taxCents: 0, withheldCents, balanceCents: 0,
      lines: [{ key: 'unsupported', label: 'Not supported', cents: 0, source: 'state figures file', assumption: 'No figures for this state' }] };
  }
  const lines: Line[] = [];
  const add = (key: string, label: string, cents: number, source: string, assumption?: string) =>
    lines.push({ key, label, cents: Math.round(cents) || 0, source, ...(assumption ? { assumption } : {}) });

  // Taxed here: everything received while resident, plus income sourced here while not. Resident income earned in another state is double-taxed.
  let taxed = 0, doubled = 0;
  for (const i of input.incomeByPeriod) {
    const resident = input.residency.some((p) => p.code === code && p.from <= i.date && i.date <= p.to);
    const amount = i.wagesCents + i.investmentCents;
    if (resident || i.sourceState === code) taxed += amount;
    if (resident && i.sourceState && i.sourceState !== code) doubled += amount;
  }
  const total = input.totalIncomeCents;
  // a loss while resident can make the taxed income negative: no negative share, so no negative tax
  const share = total > 0 ? Math.min(1, Math.max(0, taxed / total)) : 0;
  add('totalIncome', 'Total income', total, 'pay stubs and investment income');
  add('stateIncome', 'Income taxed by this state', taxed, 'pay stubs and investment income');

  let tax: number;
  if (model.model === 'flat') {
    const exemption = (input.claimable ? model.dependentExemptionCents : model.exemptionCents) * share;
    add('exemption', input.claimable ? 'Dependent exemption' : 'Personal exemption', exemption, model.source,
      share < 1 ? `Exemption prorated by the in-state share of income (${pct(share)})` : undefined);
    const taxable = Math.max(0, taxed - Math.round(exemption));
    add('taxableIncome', 'Taxable income', taxable, 'calculated');
    tax = Math.round(taxable * model.rate);
    add('tax', `Tax at ${pct(model.rate)}`, tax, model.source);
  } else {
    add('standardDeduction', 'Standard deduction', model.standardDeductionCents, model.source,
      input.claimable ? 'Claimable as a dependent: this state\'s figures have no dependent rule, so the full deduction is used' : undefined);
    const taxable = Math.max(0, total - model.standardDeductionCents);
    add('taxableIncome', 'Taxable income as a full-year resident', taxable, 'calculated');
    const surtax = Math.round(model.surtax ? Math.max(0, taxable - model.surtax.overCents) * model.surtax.rate : 0);
    const base = Math.round(Math.max(0, bracketTax(taxable, model.brackets) - model.exemptionCreditCents));
    add('fullYearTax', 'Tax on total income, less exemption credit', base, model.source);
    if (surtax) add('surtax', `Surtax at ${pct(model.surtax!.rate)}`, surtax, model.source);
    const full = base + surtax;
    tax = Math.round(full * share);
    add('ratio', `Tax × in-state share ${pct(share)}`, tax, 'calculated', share < 1 ? 'Tax apportioned by in-state income over total income' : undefined);
  }

  if (doubled > 0 && taxed > 0 && input.otherStateTaxCents > 0) {
    const credit = Math.min(input.otherStateTaxCents, Math.round(tax * Math.min(1, doubled / taxed)));
    add('otherStateCredit', 'Credit for tax paid to another state', credit, 'calculated from the other state\'s return',
      'Capped at this state\'s tax on the resident income earned in the other state');
    tax = Math.max(0, tax - credit);
  }
  add('totalTax', 'Total tax', tax, 'calculated');
  add('withheld', 'State tax withheld', withheldCents, input.withheldSource ?? 'pay stubs', input.withheldAssumption);
  const balanceCents = withheldCents - tax;
  add('balance', balanceCents >= 0 ? 'Refund' : 'Amount owed', balanceCents, 'calculated');
  return { jurisdiction: code, supported: true, lines, taxCents: tax, withheldCents, balanceCents };
}
