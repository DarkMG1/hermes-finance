// Published tax figures Ask works from, so it never guesses a limit or a bracket. Add each new year once the IRS (Rev. Proc. for the
// year, usually October) and the states publish theirs; until then Ask says that year isn't available. Amounts in cents.
const $ = (dollars: number) => Math.round(dollars * 100);

const YEARS: Record<number, unknown> = {
  2026: {
    federal: {
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
    // the EDD's 2026 DE 4 (Rev. 56), Worksheets B and C
    CA: {
      standardDeduction: { single: $(5_706), marriedJoint: $(11_412) },
      personalExemptionCredit: $(168.30),
      brackets: { single: [[$(11_079), 0.011], [$(26_264), 0.022], [$(41_452), 0.044], [$(57_542), 0.066], [$(72_724), 0.088], [$(371_479), 0.1023],
        [$(445_771), 0.1133], [$(742_953), 0.1243], [$(1_000_000), 0.1353], [null, 0.1463]] },
      sdiRate: 0.013,
      note: 'a nonresident is taxed on California-source income at the rate for total income (Form 540NR)',
    },
    // michigan.gov withholding tables for 2026
    MI: { rate: 0.0425, personalExemption: $(5_900), note: 'flat rate on taxable income; a credit for tax paid to another state on the same income' },
  },
};

export const SOURCES = 'IRS Rev. Proc. 2025-32 and Notice 2025-67, SSA, the 2026 California DE 4, michigan.gov';

export function taxReference(year: number) {
  return YEARS[year] ? { year, figures: YEARS[year], sources: SOURCES } : { year, available: Object.keys(YEARS).map(Number), note: `no ${year} figures in Hermes yet` };
}
