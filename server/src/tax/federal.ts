import type { FederalFigures } from './figures.ts';
import type { Sale } from './lots.ts';
import type { Line, ReturnResult } from './types.ts';

export type { Line, ReturnResult };

export type FederalInput = {
  filingStatus: 'single' | 'married_joint' | 'married_separate' | 'head_of_household';
  claimable: boolean; fullTimeStudent: boolean;
  /** Gross pay; `k401PreTaxCents` comes off it to give W-2 box 1 wages. */
  wagesCents: number; interestCents: number; ordinaryDividendsCents: number; qualifiedDividendsCents: number;
  sales: Sale[]; carryover: { shortCents: number; longCents: number };
  /** long-term capital gain distributions (1099-DIV box 2a): long-term gains without a sale */
  capitalGainDistributionsCents?: number;
  studentLoanInterestCents: number; k401PreTaxCents: number; tuitionCents: number; scholarshipsCents: number;
  /** null: assume years remain. */
  aotcYearsUsed: number | null;
  withheldCents: number; priorYearTaxCents: number | null; priorYearAgiCents: number | null;
  /** Where each input came from, shown on its line; `figures` names the tax figures used. */
  sources?: Partial<Record<keyof FederalInput | 'figures', string>>;
  /** What was assumed to get an input, shown on its line (wages, dividends, withholding). */
  assumptions?: Partial<Record<'wagesCents' | 'ordinaryDividendsCents' | 'withheldCents', string>>;
};

const DEFAULT_SOURCES: Record<Exclude<keyof FederalInput, 'sources' | 'assumptions'> | 'figures', string> = {
  filingStatus: 'profile', claimable: 'profile', fullTimeStudent: 'profile', wagesCents: 'pay stubs', interestCents: 'investment income',
  ordinaryDividendsCents: 'investment income', qualifiedDividendsCents: 'investment income', sales: 'investment sales', capitalGainDistributionsCents: 'investment income',
  carryover: 'carryover from prior-year return', studentLoanInterestCents: 'owner input: student loan interest', k401PreTaxCents: 'pay stubs',
  tuitionCents: 'owner input: tuition', scholarshipsCents: 'owner input: scholarships', aotcYearsUsed: 'prior returns', withheldCents: 'pay stubs',
  priorYearTaxCents: 'prior-year return', priorYearAgiCents: 'prior-year return', figures: 'IRS published figures',
};

// Statutory, not indexed: 110% safe harbor above $150,000 prior AGI; NIIT and additional Medicare tax start at $200,000 ($250,000 joint,
// $125,000 separate).
const HIGH_PRIOR_AGI = 15_000_000;
const NIIT_FLOOR = { single: 20_000_000, married_joint: 25_000_000, married_separate: 12_500_000, head_of_household: 20_000_000 };
// The IRS tax table (taxable income under $100,000) taxes the middle of each $50 row; the formula can differ by a few dollars.
const TAX_TABLE_TOP = 10_000_000;
// AOTC: 100% of the first $2,000 of expenses plus 25% of the next $2,000 (not indexed).
const AOTC_TIER = 200_000;

export const bracketTax = (cents: number, brackets: FederalFigures['brackets']['single']) => {
  let tax = 0, floor = 0;
  for (const [ceiling, rate] of brackets) {
    const top = ceiling ?? Infinity;
    if (cents > floor) tax += (Math.min(cents, top) - floor) * rate;
    floor = top;
  }
  return tax;
};
/** Share kept: 1 below the range, 0 above it, linear in between. */
const kept = (magi: number, [from, to]: [number, number]) => Math.min(1, Math.max(0, (to - magi) / (to - from)));

export function computeFederal(input: FederalInput, f: FederalFigures): ReturnResult & {
  safeHarborCents: number; unusedCarryover: { shortCents: number; longCents: number };
} {
  const src = { ...DEFAULT_SOURCES, ...input.sources };
  const lines: Line[] = [];
  const add = (key: string, label: string, cents: number, source: string, ...notes: (string | false)[]) => {
    const assumption = notes.filter(Boolean).join('; ');
    lines.push({ key, label, cents: Math.round(cents) || 0, source, ...(assumption ? { assumption } : {}) });
  };
  const joint = input.filingStatus === 'married_joint';
  const status = joint ? 'marriedJoint' : 'single';
  const statusNote = input.filingStatus === 'head_of_household' ? 'Head-of-household brackets not loaded; single brackets used'
    : input.filingStatus === 'married_separate' ? 'Married filing separately computed as single' : false;

  // Income
  const wages = input.wagesCents - input.k401PreTaxCents;
  add('wages', 'Wages', wages, src.wagesCents, input.assumptions?.wagesCents ?? false,
    input.k401PreTaxCents > 0 && 'Pre-tax 401(k) contributions taken off gross pay');
  const scholarshipIncome = Math.max(0, input.scholarshipsCents - input.tuitionCents);
  if (scholarshipIncome) add('scholarshipIncome', 'Taxable scholarships', scholarshipIncome, src.scholarshipsCents, 'Scholarships pay tuition first; the rest is taxable');
  if (input.interestCents) add('interest', 'Taxable interest', input.interestCents, src.interestCents);
  if (input.ordinaryDividendsCents) add('ordinaryDividends', 'Ordinary dividends', input.ordinaryDividendsCents, src.ordinaryDividendsCents,
    input.assumptions?.ordinaryDividendsCents ?? false);
  const qualifiedDividends = Math.min(input.qualifiedDividendsCents, input.ordinaryDividendsCents);
  if (qualifiedDividends) add('qualifiedDividends', 'Qualified dividends (included above)', qualifiedDividends, src.qualifiedDividendsCents);
  const distributions = input.capitalGainDistributionsCents ?? 0;

  const taxable = input.sales.filter((s) => s.taxable);
  const unknown = taxable.filter((s) => s.term === 'unknown').length;
  const gains = (term: Sale['term']) => taxable.filter((s) => s.term === term).reduce((sum, s) => sum + s.proceedsCents - s.costCents + s.washDisallowedCents, 0);
  const short = gains('short') - input.carryover.shortCents;
  const long = gains('long') + distributions - input.carryover.longCents;
  const lossDeduction = Math.min(Math.max(0, -(short + long)), f.capitalLossLimit);
  const capitalGain = short + long >= 0 ? short + long : -lossDeduction;
  const capitalSource = `${src.sales}; ${src.carryover}`;
  if (distributions) add('capitalGainDistributions', 'Capital gain distributions (in long-term below)', distributions, src.capitalGainDistributionsCents);
  if (taxable.length || distributions || input.carryover.shortCents || input.carryover.longCents) {
    add('shortTermNet', 'Net short-term gain or loss', short, capitalSource);
    add('longTermNet', 'Net long-term gain or loss', long, capitalSource);
    add('capitalGain', 'Capital gain or (loss)', capitalGain, capitalSource,
      unknown > 0 && `${unknown} sale${unknown === 1 ? '' : 's'} of shares bought before the trade history: cost unknown, counted as no gain`,
      short + long < 0 && -(short + long) > lossDeduction && 'Loss above the yearly limit carries to next year');
  }

  // Adjustments and AGI
  const totalIncome = wages + scholarshipIncome + input.interestCents + input.ordinaryDividendsCents + capitalGain;
  const studentLoan = input.claimable ? 0 : Math.min(input.studentLoanInterestCents, f.studentLoanInterest.max) * kept(totalIncome, f.studentLoanInterest.phaseOut[status]);
  if (input.studentLoanInterestCents) {
    add('studentLoanInterest', 'Student loan interest deduction', -studentLoan, src.studentLoanInterestCents,
      input.claimable && 'Claimable as a dependent: student loan interest not deductible');
  }
  const agi = totalIncome - Math.round(studentLoan);
  add('agi', 'Adjusted gross income', agi, 'calculated');

  const base = input.filingStatus === 'head_of_household' ? f.standardDeduction.headOfHousehold : f.standardDeduction[status];
  const earned = wages + scholarshipIncome;
  const deduction = input.claimable ? Math.min(base, Math.max(f.dependentStandardDeduction.min, earned + f.dependentStandardDeduction.addOn)) : base;
  add('standardDeduction', 'Standard deduction', deduction, src.figures, input.claimable && 'Claimable as a dependent: limited to earned income plus the add-on');
  const taxableIncome = Math.max(0, agi - deduction);
  add('taxableIncome', 'Taxable income', taxableIncome, 'calculated');

  // Capital loss carryover worksheet (Schedule D instructions): only the part of the loss that lowered taxable income is used.
  const used = Math.min(lossDeduction, Math.max(0, agi - deduction + lossDeduction));
  const unusedCarryover = {
    shortCents: short < 0 ? Math.max(0, -short - used - Math.max(0, long)) : 0,
    longCents: long < 0 ? Math.max(0, -long - Math.max(0, short) - Math.max(0, used - Math.max(0, -short))) : 0,
  };

  // Qualified Dividends and Capital Gain Tax Worksheet
  const brackets = f.brackets[status];
  const [top0, top15] = f.ltcg[status];
  const preferential = Math.min(taxableIncome, qualifiedDividends + Math.max(0, Math.min(long, short + long)));
  const ordinary = taxableIncome - preferential;
  const at0 = Math.min(preferential, Math.max(0, Math.min(taxableIncome, top0) - ordinary));
  const at15 = Math.min(preferential - at0, Math.max(0, Math.min(taxableIncome, top15) - ordinary - at0));
  const incomeTax = Math.round(Math.min(bracketTax(taxableIncome, brackets),
    bracketTax(ordinary, brackets) + at15 * 0.15 + (preferential - at0 - at15) * 0.2));
  const unearned = input.interestCents + input.ordinaryDividendsCents + Math.max(0, capitalGain);
  add('incomeTax', 'Income tax', incomeTax, src.figures, statusNote,
    taxableIncome > 0 && taxableIncome < TAX_TABLE_TOP && 'Computed by formula: the IRS tax table may differ by a few dollars',
    input.claimable && unearned > 0 && 'Kiddie tax not computed: investment income above the yearly threshold may be taxed at a parent\'s rate',
    agi > NIIT_FLOOR[input.filingStatus] && 'Net investment income tax and additional Medicare tax not computed');

  // American opportunity credit (Form 8863)
  const qualified = Math.max(0, input.tuitionCents - input.scholarshipsCents);
  const yearsLeft = input.aotcYearsUsed === null || input.aotcYearsUsed < 4;
  const aotc = input.claimable || !yearsLeft ? 0
    : Math.min(f.aotc.max, Math.min(qualified, AOTC_TIER) + 0.25 * Math.min(Math.max(0, qualified - AOTC_TIER), AOTC_TIER)) * kept(agi, f.aotc.phaseOut[status]);
  const refundable = Math.round(aotc * f.aotc.refundableShare);
  const nonrefundable = Math.min(incomeTax, Math.round(aotc) - refundable);
  if (qualified > 0) {
    const note = input.claimable ? 'Claimable as a dependent: education credit goes to whoever claims you'
      : !yearsLeft ? 'Education credit already claimed for 4 years' : input.aotcYearsUsed === null && 'Assumes education credit years remain';
    add('aotcNonrefundable', 'Education credit (nonrefundable)', -nonrefundable, `${src.tuitionCents}; ${src.scholarshipsCents}`, note);
    add('aotcRefundable', 'Education credit (refundable)', refundable, `${src.tuitionCents}; ${src.scholarshipsCents}`,
      refundable > 0 && input.fullTimeStudent && 'Assumes you are 24 or older or your earned income was more than half your support');
  }

  const taxCents = incomeTax - nonrefundable;
  add('totalTax', 'Total tax', taxCents, 'calculated');
  add('withheld', 'Federal tax withheld', input.withheldCents, src.withheldCents, input.assumptions?.withheldCents ?? false);
  if (refundable) add('refundableCredits', 'Refundable credits', refundable, 'calculated');
  const balanceCents = input.withheldCents + refundable - taxCents;
  add('balance', balanceCents >= 0 ? 'Refund' : 'Amount owed', balanceCents, 'calculated');

  // Underpayment safe harbor (Form 2210): the smaller of 90% of this year's tax after refundable credits and 100%/110% of last year's.
  const ninety = Math.round(0.9 * Math.max(0, taxCents - refundable));
  const prior = input.priorYearTaxCents === null ? null
    : Math.round(input.priorYearTaxCents * (input.priorYearAgiCents === null || input.priorYearAgiCents > HIGH_PRIOR_AGI ? 1.1 : 1));
  const safeHarborCents = prior === null ? ninety : Math.min(ninety, prior);
  add('safeHarbor', 'Pay at least this to avoid a penalty', safeHarborCents, prior === null ? 'calculated' : src.priorYearTaxCents,
    prior === null ? 'No prior-year tax entered: safe harbor is 90% of this year\'s tax'
      : input.priorYearAgiCents === null && 'Prior-year AGI unknown: 110% of prior-year tax used');

  return { jurisdiction: 'federal', supported: true, lines, taxCents, withheldCents: input.withheldCents, balanceCents, safeHarborCents, unusedCarryover };
}
