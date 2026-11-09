import { readFileSync } from 'node:fs';

// Published tax figures Ask works from, so it never guesses a limit or a bracket. Add each new year once the IRS publishes it (Rev. Proc.
// for the year, usually October); until then Ask says that year isn't available. Amounts in cents. State figures live in a file on the
// server (HERMES_STATE_TAX_FILE: { "<year>": { "<state code>": { ..., "source": "..." } } }), since which states says where the owner lives.
const $ = (dollars: number) => Math.round(dollars * 100);

const YEARS: Record<number, unknown> = {
  2026: {
    // Rev. Proc. 2025-32
    standardDeduction: { single: $(16_100), marriedJoint: $(32_200), headOfHousehold: $(24_150) },
    dependentStandardDeduction: 'the greater of $1,350 or earned income plus $450, at most the single standard deduction',
    brackets: { single: [[$(12_400), 0.10], [$(50_400), 0.12], [$(105_700), 0.22], [$(201_775), 0.24], [$(256_225), 0.32], [$(640_600), 0.35], [null, 0.37]] },
    capitalLossLimitAgainstOrdinaryIncome: $(3_000),
    socialSecurity: { rate: 0.062, wageBase: $(184_500) },
    medicare: { rate: 0.0145 },
    supplementalWithholdingRate: 0.22,
    // Notice 2025-67
    iraLimit: $(7_500), iraCatchUp50: $(1_100), rothPhaseOut: { single: [$(153_000), $(168_000)], marriedJoint: [$(242_000), $(252_000)] },
    americanOpportunityCredit: { max: $(2_500), refundableShare: 0.4, phaseOut: { single: [$(80_000), $(90_000)], marriedJoint: [$(160_000), $(180_000)] },
      note: '100% of the first $2,000 of qualified tuition and fees plus 25% of the next $2,000; 4 tax years per student; not when someone can claim the student as a dependent' },
    studentLoanInterest: { max: $(2_500), phaseOut: { single: [$(85_000), $(100_000)], marriedJoint: [$(175_000), $(205_000)] } },
  },
};

export const SOURCES = 'IRS Rev. Proc. 2025-32 and Notice 2025-67, SSA';

export function taxReference(year: number, stateFile: string | null) {
  if (!YEARS[year]) return { year, available: Object.keys(YEARS).map(Number), note: `no ${year} figures in Hermes yet` };
  let states: unknown;
  try { states = stateFile ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>)[String(year)] : undefined; } catch { states = undefined; }
  return { year, federal: YEARS[year], sources: SOURCES, ...(states ? { states } : {}) };
}
