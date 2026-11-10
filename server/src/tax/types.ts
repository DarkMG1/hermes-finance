import type { TaxWhatIfChange } from '@hermes/shared';

/** One return-style line; `source` says where the number came from, `assumption` what was assumed to get it. */
export type Line = { key: string; label: string; cents: number; source: string; assumption?: string };
export type ReturnResult = {
  jurisdiction: 'federal' | string; supported: boolean; lines: Line[]; taxCents: number; withheldCents: number;
  /** + refund, − owed */
  balanceCents: number;
  /** federal only */
  safeHarborCents?: number; unusedCarryover?: { shortCents: number; longCents: number };
};

export type Advice = {
  kind: 'harvest_loss' | 'roth_room' | 'k401_room' | 'education_credit' | 'student_loan_interest' | 'moving_expenses' | 'estimated_payment'
    | 'withholding_short' | 'over_limit';
  title: string; detail: string; savingsCents: number | null; dueDate: string | null; askPrompt: string;
};
export type TaxProjection = {
  year: number; openYears: number[]; asOf: string;
  /** false: a return isn't supported (no figures), so its tax is missing from the total */
  complete: boolean;
  /** the supported returns' balances added up: + refund, − owed */
  combinedBalanceCents: number; returns: ReturnResult[]; assumptions: string[];
  figures: { federalYear: number; fallback: boolean }; waysToSave: Advice[]; headsUp: Advice[];
};
/** A change to try: shares to sell now (at the last synced price), extra federal withholding for the year, scenario inputs over the stored ones. */
export type WhatIf = TaxWhatIfChange;
