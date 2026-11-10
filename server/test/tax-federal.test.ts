import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federalFigures } from '../src/tax/figures.ts';
import { computeFederal, type FederalInput } from '../src/tax/federal.ts';
import type { Sale } from '../src/tax/lots.ts';
import type { Line } from '../src/tax/types.ts';

// All figures are 2026 (Rev. Proc. 2025-32): single SD $16,100; brackets 10% to $12,400, 12% to $50,400, 22% to $105,700, …
const F = federalFigures(2026).figures;
const $ = (dollars: number) => Math.round(dollars * 100);

function input(over: Partial<FederalInput> = {}): FederalInput {
  return {
    filingStatus: 'single', claimable: false, fullTimeStudent: false, wagesCents: 0, interestCents: 0, ordinaryDividendsCents: 0,
    qualifiedDividendsCents: 0, sales: [], carryover: { shortCents: 0, longCents: 0 }, studentLoanInterestCents: 0, k401PreTaxCents: 0,
    tuitionCents: 0, scholarshipsCents: 0, aotcYearsUsed: null, withheldCents: 0, priorYearTaxCents: null, priorYearAgiCents: null, ...over,
  };
}

function sale(term: Sale['term'], proceeds: number, cost: number, over: Partial<Sale> = {}): Sale {
  return { accountId: 'brk', securityId: 'sx', date: '2026-06-01', quantity: 1, proceedsCents: $(proceeds), costCents: $(cost),
    acquiredOn: term === 'unknown' ? null : '2025-01-01', term, washDisallowedCents: 0, taxable: true, ...over };
}

const line = (r: { lines: Line[] }, key: string) => r.lines.find((l) => l.key === key);
const cents = (r: { lines: Line[] }, key: string) => line(r, key)?.cents;
const assumptions = (r: { lines: Line[] }) => r.lines.map((l) => l.assumption).filter(Boolean).join(' | ');

test('wages only, standard deduction', () => {
  // gross 64,000 − 401(k) 4,000 = wages 60,000 = AGI; TI = 60,000 − 16,100 = 43,900
  // tax = 12,400 × 10% + (43,900 − 12,400) × 12% = 1,240 + 3,780 = 5,020; withheld 6,000 → refund 980
  const r = computeFederal(input({ wagesCents: $(64_000), k401PreTaxCents: $(4_000), withheldCents: $(6_000) }), F);
  assert.equal(r.jurisdiction, 'federal');
  assert.equal(r.supported, true);
  assert.equal(cents(r, 'wages'), $(60_000));
  assert.equal(cents(r, 'agi'), $(60_000));
  assert.equal(cents(r, 'standardDeduction'), $(16_100));
  assert.equal(cents(r, 'taxableIncome'), $(43_900));
  assert.equal(r.taxCents, $(5_020));
  assert.equal(r.withheldCents, $(6_000));
  assert.equal(r.balanceCents, $(980));
  assert.ok(r.lines.every((l) => l.source.length > 0));
  assert.equal(line(r, 'wages')?.source, 'pay stubs');
  const sourced = computeFederal(input({ wagesCents: $(1_000), sources: { wagesCents: 'W-2', figures: 'Rev. Proc. 2025-32' } }), F);
  assert.equal(line(sourced, 'wages')?.source, 'W-2');
  assert.equal(line(sourced, 'standardDeduction')?.source, 'Rev. Proc. 2025-32');
});

test('married joint uses joint figures; head of household and married separate are labelled', () => {
  // MFJ: 100,000 − 32,200 = 67,800; 24,800 × 10% + 43,000 × 12% = 2,480 + 5,160 = 7,640
  assert.equal(computeFederal(input({ filingStatus: 'married_joint', wagesCents: $(100_000) }), F).taxCents, $(7_640));
  // HoH: 60,000 − 24,150 = 35,850 on single brackets: 1,240 + 23,450 × 12% = 1,240 + 2,814 = 4,054
  const hoh = computeFederal(input({ filingStatus: 'head_of_household', wagesCents: $(60_000) }), F);
  assert.equal(hoh.taxCents, $(4_054));
  assert.match(assumptions(hoh), /Head-of-household brackets not loaded; single brackets used/);
  // MFS: same as single (5,020 from the first test)
  const mfs = computeFederal(input({ filingStatus: 'married_separate', wagesCents: $(60_000) }), F);
  assert.equal(mfs.taxCents, $(5_020));
  assert.match(assumptions(mfs), /Married filing separately computed as single/);
});

test('dependent standard deduction = max(1,350, earned + 450), capped at the regular one', () => {
  // wages 5,000: max(1,350, 5,450) = 5,450 > AGI → TI 0
  const a = computeFederal(input({ claimable: true, wagesCents: $(5_000) }), F);
  assert.equal(cents(a, 'standardDeduction'), $(5_450));
  assert.equal(cents(a, 'taxableIncome'), 0);
  assert.equal(a.taxCents, 0);
  // wages 500 + interest 3,000: max(1,350, 950) = 1,350; TI = 3,500 − 1,350 = 2,150 → 215
  const b = computeFederal(input({ claimable: true, wagesCents: $(500), interestCents: $(3_000) }), F);
  assert.equal(cents(b, 'standardDeduction'), $(1_350));
  assert.equal(b.taxCents, $(215));
  // wages 20,000: min(16,100, 20,450) = 16,100
  assert.equal(cents(computeFederal(input({ claimable: true, wagesCents: $(20_000) }), F), 'standardDeduction'), $(16_100));
  // scholarships 3,000 over tuition 1,000: 2,000 taxable and earned → max(1,350, 3,000 + 2,000 + 450) = 5,450; AGI 5,000
  const c = computeFederal(input({ claimable: true, wagesCents: $(3_000), tuitionCents: $(1_000), scholarshipsCents: $(3_000) }), F);
  assert.equal(cents(c, 'scholarshipIncome'), $(2_000));
  assert.equal(cents(c, 'agi'), $(5_000));
  assert.equal(cents(c, 'standardDeduction'), $(5_450));
});

test('short and long losses net against gains; $3,000 limit; carryover split preserved', () => {
  // short: +1,000 (3,000 − 2,000) + 0 (wash: 1,000 − 1,500 + 500) − carryover 2,000 = −1,000
  // long: −6,000 (4,000 − 10,000) − carryover 500 = −6,500; IRA sale and unknown-term sale ignored; net −7,500 → deduct 3,000
  // AGI = 50,000 − 3,000 = 47,000; TI = 30,900 → 1,240 + 18,500 × 12% = 3,460
  // carryover worksheet: line4 = min(3,000, 30,900 + 3,000) = 3,000; short carry = 1,000 − 3,000 → 0;
  // long carry = 6,500 − (0 + (3,000 − 1,000)) = 4,500
  const r = computeFederal(input({
    wagesCents: $(50_000), carryover: { shortCents: $(2_000), longCents: $(500) },
    sales: [sale('short', 3_000, 2_000), sale('short', 1_000, 1_500, { washDisallowedCents: $(500) }), sale('long', 4_000, 10_000),
      sale('short', 9_000, 1_000, { taxable: false }), sale('unknown', 5_000, 0)],
  }), F);
  assert.equal(cents(r, 'shortTermNet'), $(-1_000));
  assert.equal(cents(r, 'longTermNet'), $(-6_500));
  assert.equal(cents(r, 'capitalGain'), $(-3_000));
  assert.equal(cents(r, 'agi'), $(47_000));
  assert.equal(r.taxCents, $(3_460));
  assert.deepEqual(r.unusedCarryover, { shortCents: 0, longCents: $(4_500) });
  assert.match(assumptions(r), /1 sale of shares bought before the trade history: cost unknown, counted as no gain/);

  // short −4,000, long −1,000 (carryovers only), wages 50,000: line4 = 3,000; short carry 4,000 − 3,000 = 1,000;
  // long carry 1,000 − (0 + max(0, 3,000 − 4,000)) = 1,000
  const s = computeFederal(input({ wagesCents: $(50_000), carryover: { shortCents: $(4_000), longCents: $(1_000) } }), F);
  assert.deepEqual(s.unusedCarryover, { shortCents: $(1_000), longCents: $(1_000) });

  // low income: wages 17,100, net −6,000 → deduct 3,000, AGI 14,100, TI before floor −2,000
  // line3 = −2,000 + 3,000 = 1,000 → line4 = 1,000 used; short carry 1,000 − 1,000 = 0; long carry 5,000 − (0 + 0) = 5,000
  const t = computeFederal(input({ wagesCents: $(17_100), carryover: { shortCents: $(1_000), longCents: $(5_000) } }), F);
  assert.equal(cents(t, 'taxableIncome'), 0);
  assert.deepEqual(t.unusedCarryover, { shortCents: 0, longCents: $(5_000) });

  // a gain absorbs the carryover: long +8,000 − 2,000 carry = 6,000 net, nothing left over
  const u = computeFederal(input({ wagesCents: $(50_000), carryover: { shortCents: 0, longCents: $(2_000) }, sales: [sale('long', 10_000, 2_000)] }), F);
  assert.equal(cents(u, 'capitalGain'), $(6_000));
  assert.deepEqual(u.unusedCarryover, { shortCents: 0, longCents: 0 });
});

test('long-term gains and qualified dividends use the 0/15/20 thresholds', () => {
  // wages 40,000 + ordinary divs 3,000 (2,000 qualified) + long 20,000 = AGI 63,000; TI 46,900; preferential 22,000, ordinary 24,900
  // all preferential below 49,450 → 0%; tax = 1,240 + 12,500 × 12% = 2,740
  const a = computeFederal(input({ wagesCents: $(40_000), ordinaryDividendsCents: $(3_000), qualifiedDividendsCents: $(2_000),
    sales: [sale('long', 30_000, 10_000)] }), F);
  assert.equal(cents(a, 'agi'), $(63_000));
  assert.equal(a.taxCents, $(2_740));
  // wages 50,000 + long 30,000: TI 63,900, ordinary 33,900; 0% on 49,450 − 33,900 = 15,550; 15% on 14,450 = 2,167.50
  // ordinary tax 1,240 + 21,500 × 12% = 3,820 → 5,987.50
  const b = computeFederal(input({ wagesCents: $(50_000), sales: [sale('long', 40_000, 10_000)] }), F);
  assert.equal(b.taxCents, $(5_987.5));
  // a short gain is ordinary: wages 50,000 + short 30,000 → TI 63,900 regular: 5,800 + 13,500 × 22% = 8,770
  assert.equal(computeFederal(input({ wagesCents: $(50_000), sales: [sale('short', 40_000, 10_000)] }), F).taxCents, $(8_770));
  // wages 560,000 + long 50,000: TI 593,900, ordinary 543,900; 15% on 545,500 − 543,900 = 1,600 (240); 20% on 48,400 (9,680)
  // ordinary: 1,240 + 4,560 + 12,166 + 23,058 + 17,424 + (543,900 − 256,225) × 35% = 100,686.25 → 159,134.25; total 169,054.25
  const c = computeFederal(input({ wagesCents: $(560_000), sales: [sale('long', 60_000, 10_000)] }), F);
  assert.equal(c.taxCents, $(169_054.25));
  assert.match(assumptions(c), /Net investment income tax and additional Medicare tax not computed/);
});

test('AOTC 100%/25% of first $2,000/$2,000, 40% refundable, phased out between $80k and $90k, none when claimable', () => {
  // tuition 5,000 − scholarships 500 = 4,500: 2,000 + 25% × 2,000 = 2,500; refundable 1,000, nonrefundable 1,500
  // wages 30,000 → TI 13,900 → tax 1,240 + 180 = 1,420; nonrefundable limited to 1,420 → tax 0; balance 1,000 withheld + 1,000
  const a = computeFederal(input({ wagesCents: $(30_000), tuitionCents: $(5_000), scholarshipsCents: $(500), withheldCents: $(1_000) }), F);
  assert.equal(cents(a, 'incomeTax'), $(1_420));
  assert.equal(cents(a, 'aotcNonrefundable'), $(-1_420));
  assert.equal(cents(a, 'aotcRefundable'), $(1_000));
  assert.equal(a.taxCents, 0);
  assert.equal(a.balanceCents, $(2_000));
  assert.match(assumptions(a), /Assumes education credit years remain/);
  // MAGI 85,000: factor (90,000 − 85,000) / 10,000 = 0.5 → 1,250; refundable 500, nonrefundable 750
  const b = computeFederal(input({ wagesCents: $(85_000), tuitionCents: $(4_000), aotcYearsUsed: 1 }), F);
  assert.equal(cents(b, 'aotcRefundable'), $(500));
  assert.equal(cents(b, 'aotcNonrefundable'), $(-750));
  assert.doesNotMatch(assumptions(b), /years remain/);
  // 1,000 tuition: 1,000 credit, 400 refundable
  assert.equal(cents(computeFederal(input({ wagesCents: $(30_000), tuitionCents: $(1_000) }), F), 'aotcRefundable'), $(400));
  for (const over of [{ claimable: true }, { aotcYearsUsed: 4 }, { wagesCents: $(95_000) }]) {
    const r = computeFederal(input({ wagesCents: $(30_000), tuitionCents: $(4_000), ...over }), F);
    assert.equal(cents(r, 'aotcRefundable') ?? 0, 0);
    assert.equal(cents(r, 'aotcNonrefundable') ?? 0, 0);
  }
  assert.match(assumptions(computeFederal(input({ claimable: true, wagesCents: $(30_000), tuitionCents: $(4_000) }), F)), /dependent/);
});

test('student loan interest up to $2,500, phased out', () => {
  // paid 3,000 → 2,500; AGI 60,000 − 2,500 = 57,500
  const a = computeFederal(input({ wagesCents: $(60_000), studentLoanInterestCents: $(3_000) }), F);
  assert.equal(cents(a, 'studentLoanInterest'), $(-2_500));
  assert.equal(cents(a, 'agi'), $(57_500));
  // MAGI 90,000: reduction 2,000 × (90,000 − 85,000) / 15,000 = 666.67 → 1,333.33
  const b = computeFederal(input({ wagesCents: $(90_000), studentLoanInterestCents: $(2_000) }), F);
  assert.equal(cents(b, 'studentLoanInterest'), -133_333);
  assert.equal(cents(computeFederal(input({ wagesCents: $(100_000), studentLoanInterestCents: $(2_000) }), F), 'studentLoanInterest') ?? 0, 0);
  assert.equal(cents(computeFederal(input({ claimable: true, wagesCents: $(30_000), studentLoanInterestCents: $(2_000) }), F), 'studentLoanInterest') ?? 0, 0);
});

test('safe harbor is 100% of prior tax (110% above $150k AGI) or 90% of this year', () => {
  // this year's tax 5,020 (wages 60,000) → 90% = 4,518
  const w = { wagesCents: $(60_000) };
  assert.equal(computeFederal(input({ ...w, priorYearTaxCents: $(4_000), priorYearAgiCents: $(100_000) }), F).safeHarborCents, $(4_000));
  assert.equal(computeFederal(input({ ...w, priorYearTaxCents: $(4_000), priorYearAgiCents: $(160_000) }), F).safeHarborCents, $(4_400));
  assert.equal(computeFederal(input({ ...w, priorYearTaxCents: $(6_000), priorYearAgiCents: $(160_000) }), F).safeHarborCents, $(4_518));
  const none = computeFederal(input({ ...w }), F);
  assert.equal(none.safeHarborCents, $(4_518));
  assert.match(assumptions(none), /90% of this year/);
  // prior AGI unknown → 110%: 4,000 × 1.1 = 4,400
  const noAgi = computeFederal(input({ ...w, priorYearTaxCents: $(4_000) }), F);
  assert.equal(noAgi.safeHarborCents, $(4_400));
  assert.match(assumptions(noAgi), /110%/);
  // refundable credit lowers this year's tax for the 90% test: tax 0 − refundable 1,000 → floor 0
  assert.equal(computeFederal(input({ wagesCents: $(30_000), tuitionCents: $(5_000) }), F).safeHarborCents, 0);
});

test('labels: tax by formula under the tax table limit; kiddie tax for any claimable filer with investment income; NIIT floor by status', () => {
  const small = computeFederal(input({ wagesCents: $(40_000) }), F);
  assert.match(line(small, 'incomeTax')!.assumption ?? '', /IRS tax table may differ/);
  assert.doesNotMatch(line(computeFederal(input({ wagesCents: $(150_000) }), F), 'incomeTax')!.assumption ?? '', /tax table/);
  assert.match(line(computeFederal(input({ claimable: true, wagesCents: $(5_000), interestCents: $(3_000) }), F), 'incomeTax')!.assumption ?? '', /Kiddie tax/);
  assert.doesNotMatch(line(computeFederal(input({ filingStatus: 'married_joint', wagesCents: $(220_000) }), F), 'incomeTax')!.assumption ?? '', /Net investment/);
  assert.match(line(computeFederal(input({ filingStatus: 'married_joint', wagesCents: $(260_000) }), F), 'incomeTax')!.assumption ?? '', /Net investment/);
  assert.match(line(computeFederal(input({ wagesCents: $(210_000) }), F), 'incomeTax')!.assumption ?? '', /Net investment/);
});

test('qualified dividends never exceed ordinary ones; long-term distributions are long-term gains', () => {
  const r = computeFederal(input({ wagesCents: $(60_000), ordinaryDividendsCents: $(100), qualifiedDividendsCents: $(500), capitalGainDistributionsCents: $(300) }), F);
  assert.equal(cents(r, 'qualifiedDividends'), $(100));
  assert.deepEqual([cents(r, 'capitalGainDistributions'), cents(r, 'longTermNet'), cents(r, 'capitalGain')], [$(300), $(300), $(300)]);
  assert.equal(cents(r, 'agi'), $(60_400));
});
