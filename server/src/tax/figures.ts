import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Published tax figures in cents. Add each year once the IRS publishes its Rev. Proc. (usually October); until then federalFigures falls back
// to the latest year and says so. State figures live in a file on the server (HERMES_STATE_TAX_FILE), since which states says where the owner lives.
const $ = (dollars: number) => Math.round(dollars * 100);
type Bracket = [ceilingCents: number | null, rate: number];
type Pair = [number, number];

export type FederalFigures = {
  standardDeduction: { single: number; marriedJoint: number; headOfHousehold: number };
  dependentStandardDeduction: { min: number; addOn: number };
  brackets: { single: Bracket[]; marriedJoint: Bracket[] };
  /** Top of the 0% and of the 15% long-term rate, by filing status. */
  ltcg: { single: Pair; marriedJoint: Pair };
  capitalLossLimit: number;
  socialSecurity: { rate: number; wageBase: number };
  medicare: { rate: number };
  supplementalRate: number;
  ira: { limit: number; catchUp50: number };
  rothPhaseOut: { single: Pair; marriedJoint: Pair };
  aotc: { max: number; refundableShare: number; phaseOut: { single: Pair; marriedJoint: Pair }; note: string };
  studentLoanInterest: { max: number; phaseOut: { single: Pair; marriedJoint: Pair } };
  k401Limit: number;
  /** Figure groups copied from the previous year because the IRS has not published the new ones. */
  carriedFrom2026?: ('ira' | 'rothPhaseOut' | 'k401Limit')[];
};

const Y2026: FederalFigures = {
  // Rev. Proc. 2025-32 (https://www.irs.gov/pub/irs-drop/rp-25-32.pdf): sections 3.01 rate tables, 3.03 capital gains, 3.15 standard deduction
  standardDeduction: { single: $(16_100), marriedJoint: $(32_200), headOfHousehold: $(24_150) },
  dependentStandardDeduction: { min: $(1_350), addOn: $(450) },
  brackets: {
    single: [[$(12_400), 0.10], [$(50_400), 0.12], [$(105_700), 0.22], [$(201_775), 0.24], [$(256_225), 0.32], [$(640_600), 0.35], [null, 0.37]],
    marriedJoint: [[$(24_800), 0.10], [$(100_800), 0.12], [$(211_400), 0.22], [$(403_550), 0.24], [$(512_450), 0.32], [$(768_700), 0.35], [null, 0.37]],
  },
  ltcg: { single: [$(49_450), $(545_500)], marriedJoint: [$(98_900), $(613_700)] },
  capitalLossLimit: $(3_000),
  socialSecurity: { rate: 0.062, wageBase: $(184_500) }, // SSA contribution and benefit base
  medicare: { rate: 0.0145 },
  supplementalRate: 0.22,
  // 401(k) $24,500, IRA $7,500 (catch-up $1,100), Roth phase-outs: Notice 2025-67 / IR-2025-111
  // (https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500)
  ira: { limit: $(7_500), catchUp50: $(1_100) },
  rothPhaseOut: { single: [$(153_000), $(168_000)], marriedJoint: [$(242_000), $(252_000)] },
  aotc: { max: $(2_500), refundableShare: 0.4, phaseOut: { single: [$(80_000), $(90_000)], marriedJoint: [$(160_000), $(180_000)] },
    note: '100% of the first $2,000 of qualified tuition and fees plus 25% of the next $2,000; 4 tax years per student; not when someone can claim the student as a dependent' },
  studentLoanInterest: { max: $(2_500), phaseOut: { single: [$(85_000), $(100_000)], marriedJoint: [$(175_000), $(205_000)] } },
  k401Limit: $(24_500),
};

const YEARS: Record<number, FederalFigures> = {
  2026: Y2026,
  2027: {
    ...Y2026,
    // Rev. Proc. 2026-35 (https://www.irs.gov/pub/irs-drop/rp-26-35.pdf), IR-2026-133: sections 3.01 tables, 3.03 capital gains, 3.15 standard deduction, 3.31 student loan interest
    standardDeduction: { single: $(16_600), marriedJoint: $(33_200), headOfHousehold: $(24_925) },
    dependentStandardDeduction: { min: $(1_400), addOn: $(500) },
    brackets: {
      single: [[$(12_800), 0.10], [$(52_025), 0.12], [$(109_125), 0.22], [$(208_325), 0.24], [$(264_550), 0.32], [$(661_375), 0.35], [null, 0.37]],
      marriedJoint: [[$(25_600), 0.10], [$(104_050), 0.12], [$(218_250), 0.22], [$(416_650), 0.24], [$(529_100), 0.32], [$(793_650), 0.35], [null, 0.37]],
    },
    ltcg: { single: [$(51_050), $(563_200)], marriedJoint: [$(102_100), $(633_600)] },
    studentLoanInterest: { max: $(2_500), phaseOut: { single: [$(90_000), $(105_000)], marriedJoint: [$(180_000), $(210_000)] } },
    // SSA 2027 contribution and benefit base (https://www.ssa.gov/oact/cola/cbb.html)
    socialSecurity: { rate: 0.062, wageBase: $(192_300) },
    // 2027 IRA, Roth phase-out and 401(k) limits are not yet published (the annual Notice usually follows in November): 2026 amounts used
    carriedFrom2026: ['ira', 'rothPhaseOut', 'k401Limit'],
  },
};

export const SOURCES = 'IRS Rev. Proc. 2025-32 (2026), Rev. Proc. 2026-35 (2027), Notice 2025-67, SSA';

export const federalYears = () => Object.keys(YEARS).map(Number);

/** The year's figures, else the latest earlier year's (the earliest year's for a year before them all), with fallback true. */
export function federalFigures(year: number): { figures: FederalFigures; year: number; fallback: boolean } {
  const exact = YEARS[year];
  if (exact) return { figures: exact, year, fallback: false };
  const years = federalYears();
  const used = Math.max(...years.filter((y) => y < year), Math.min(...years));
  return { figures: YEARS[used]!, year: used, fallback: true };
}

const Rate = z.number().min(0).max(1);
const Cents = z.number().int().nonnegative();
export const StateModel = z.discriminatedUnion('model', [
  z.object({ model: z.literal('flat'), rate: Rate, exemptionCents: Cents, dependentExemptionCents: Cents, supplementalRate: Rate.optional(), source: z.string() }),
  z.object({
    model: z.literal('progressive_ratio'),
    brackets: z.array(z.tuple([Cents.nullable(), Rate])).min(1),
    standardDeductionCents: Cents, exemptionCreditCents: Cents,
    surtax: z.object({ overCents: Cents, rate: Rate }).optional(),
    movingExpenses: z.boolean(), supplementalRate: Rate.optional(), source: z.string(),
  }),
]);
export type StateModel = z.infer<typeof StateModel>;

/** The code's model for `year` from the state file, or the latest earlier year that has the code (fallback true). Anything missing or malformed is null. */
export function stateFigures(file: string | null, year: number, code: string): { model: StateModel; year: number; fallback: boolean } | null {
  if (!file) return null;
  try {
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    const used = Object.keys(all).map(Number).filter((y) => y <= year && all[String(y)]?.[code] !== undefined).sort((a, b) => b - a)[0];
    if (used === undefined) return null;
    const parsed = StateModel.safeParse(all[String(used)]![code]);
    return parsed.success ? { model: parsed.data, year: used, fallback: used !== year } : null;
  } catch { return null; }
}
