import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StateModel } from '../src/tax/figures.ts';
import { computeState, type StateInput } from '../src/tax/state.ts';
import type { Line } from '../src/tax/types.ts';

const $ = (dollars: number) => Math.round(dollars * 100);
// Synthetic figures. XA: flat 4%, exemption 5,000 (1,000 if claimable). XB: 2% to 20,000 then 5%, SD 5,000, credit 100, 1% over 100,000.
const XA: StateModel = { model: 'flat', rate: 0.04, exemptionCents: $(5_000), dependentExemptionCents: $(1_000), source: 'synthetic XA' };
const XB: StateModel = {
  model: 'progressive_ratio', brackets: [[$(20_000), 0.02], [null, 0.05]], standardDeductionCents: $(5_000), exemptionCreditCents: $(100),
  surtax: { overCents: $(100_000), rate: 0.01 }, movingExpenses: false, source: 'synthetic XB',
};
const YEAR = [{ from: '2026-01-01', to: '2026-12-31' }];
const inc = (wages: number, date: string, sourceState: string | null = null, investment = 0) =>
  ({ wagesCents: $(wages), investmentCents: $(investment), sourceState, date });

function input(over: Partial<StateInput>): StateInput {
  const income = over.incomeByPeriod ?? [];
  return {
    code: 'XA', residency: YEAR.map((p) => ({ code: over.code ?? 'XA', ...p })), incomeByPeriod: income,
    totalIncomeCents: income.reduce((s, i) => s + i.wagesCents + i.investmentCents, 0), claimable: false, withheldCents: 0,
    otherStateTaxCents: 0, ...over,
  };
}
const line = (r: { lines: Line[] }, key: string) => r.lines.find((l) => l.key === key);

test('flat full-year resident', () => {
  // 60,000 − 5,000 = 55,000 × 4% = 2,200; withheld 2,500 → refund 300
  const r = computeState(input({ incomeByPeriod: [inc(60_000, '2026-06-15')], withheldCents: $(2_500) }), XA);
  assert.equal(r.jurisdiction, 'XA');
  assert.equal(r.supported, true);
  assert.equal(line(r, 'exemption')?.cents, $(5_000));
  assert.equal(line(r, 'taxableIncome')?.cents, $(55_000));
  assert.equal(r.taxCents, $(2_200));
  assert.equal(r.balanceCents, $(300));
  assert.equal(line(r, 'tax')?.source, 'synthetic XA');
  // claimable: 60,000 − 1,000 = 59,000 × 4% = 2,360
  assert.equal(computeState(input({ incomeByPeriod: [inc(60_000, '2026-06-15')], claimable: true }), XA).taxCents, $(2_360));
});

test('flat part-year: only income earned while resident, exemption prorated by the in-state share of income', () => {
  // resident Jan 1–Jun 30 (inclusive): 30,000 dated Jun 30 is resident income
  // nonresident: 40,000 sourced to XC (not taxed), 10,000 sourced to XA (taxed)
  // taxed 40,000 / total 80,000 = 50%; exemption 5,000 × 50% = 2,500; 37,500 × 4% = 1,500
  const r = computeState(input({
    residency: [{ code: 'XA', from: '2026-01-01', to: '2026-06-30' }, { code: 'XC', from: '2026-07-01', to: '2026-12-31' }],
    incomeByPeriod: [inc(30_000, '2026-06-30'), inc(40_000, '2026-07-01', 'XC'), inc(10_000, '2026-09-30', 'XA')],
  }), XA);
  assert.equal(line(r, 'stateIncome')?.cents, $(40_000));
  assert.equal(line(r, 'exemption')?.cents, $(2_500));
  assert.match(line(r, 'exemption')?.assumption ?? '', /prorated/);
  assert.equal(r.taxCents, $(1_500));
});

test('progressive nonresident pays tax on total income × in-state share', () => {
  // total 120,000 − SD 5,000 = 115,000; 20,000 × 2% + 95,000 × 5% = 400 + 4,750 = 5,150 − credit 100 = 5,050
  // surtax (115,000 − 100,000) × 1% = 150 → 5,200 as a full-year resident; share 30,000 / 120,000 = 25% → 1,300
  const r = computeState(input({
    code: 'XB', residency: YEAR.map((p) => ({ code: 'XC', ...p })),
    incomeByPeriod: [inc(90_000, '2026-04-01', 'XC'), inc(30_000, '2026-05-01', 'XB')],
  }), XB);
  assert.equal(line(r, 'fullYearTax')?.cents, $(5_050));
  assert.equal(line(r, 'surtax')?.cents, $(150));
  assert.equal(line(r, 'ratio')?.cents, $(1_300));
  assert.match(line(r, 'ratio')?.label ?? '', /25\.0%/);
  assert.equal(r.taxCents, $(1_300));
  assert.equal(r.balanceCents, -$(1_300));
});

test('progressive part-year: resident-period income plus in-state income from the nonresident period', () => {
  // XC resident Jan–Jun: 40,000 sourced to XC (not taxed) + 10,000 sourced to XB (taxed); XB resident Jul–Dec: 45,000 wages + 5,000 investment
  // total 100,000 − 5,000 = 95,000: 400 + 75,000 × 5% = 4,150 − 100 = 4,050, no surtax; share 60,000 / 100,000 = 60% → 2,430
  const r = computeState(input({
    code: 'XB', residency: [{ code: 'XC', from: '2026-01-01', to: '2026-06-30' }, { code: 'XB', from: '2026-07-01', to: '2026-12-31' }],
    incomeByPeriod: [inc(40_000, '2026-03-15', 'XC'), inc(10_000, '2026-05-15', 'XB'), inc(45_000, '2026-09-15', 'XB', 5_000)],
  }), XB);
  assert.equal(line(r, 'stateIncome')?.cents, $(60_000));
  assert.equal(r.taxCents, $(2_430));
});

test('credit for tax paid to the other state is capped at this state\'s tax on that income', () => {
  // resident all year; 30,000 of 80,000 sourced to XC. 80,000 − 5,000 = 75,000 × 4% = 3,000
  // cap 3,000 × 30,000 / 80,000 = 1,125: XC tax 2,000 → credit 1,125, tax 1,875; XC tax 800 → credit 800, tax 2,200
  const base = { incomeByPeriod: [inc(50_000, '2026-02-01'), inc(30_000, '2026-08-01', 'XC')] };
  const capped = computeState(input({ ...base, otherStateTaxCents: $(2_000) }), XA);
  assert.equal(line(capped, 'otherStateCredit')?.cents, $(1_125));
  assert.equal(capped.taxCents, $(1_875));
  assert.equal(computeState(input({ ...base, otherStateTaxCents: $(800) }), XA).taxCents, $(2_200));
  // income sourced to XC while a nonresident of XA gets no credit (XA doesn't tax it): 20,000 resident only
  // taxed 20,000 / 50,000 = 40%; exemption 2,000; 18,000 × 4% = 720
  const nonres = computeState(input({
    residency: [{ code: 'XA', from: '2026-01-01', to: '2026-03-31' }],
    incomeByPeriod: [inc(20_000, '2026-02-01'), inc(30_000, '2026-08-01', 'XC')], otherStateTaxCents: $(2_000),
  }), XA);
  assert.equal(line(nonres, 'otherStateCredit'), undefined);
  assert.equal(nonres.taxCents, $(720));
});

test('unknown state is not supported', () => {
  const r = computeState(input({ code: 'XC', incomeByPeriod: [inc(10_000, '2026-02-01')], withheldCents: $(300) }), null);
  assert.equal(r.supported, false);
  assert.equal(r.taxCents, 0);
  assert.equal(r.withheldCents, $(300));
  // its tax is unknown, so withholding is no refund
  assert.equal(r.balanceCents, 0);
  assert.deepEqual(r.lines.map((l) => l.assumption), ['No figures for this state']);
});

test('a loss while resident never makes a negative tax', () => {
  // 100,000 earned in XA before moving to XB, then a 3,000 investment loss as an XB resident
  const r = computeState(input({
    code: 'XB', residency: [{ code: 'XA', from: '2026-01-01', to: '2026-06-30' }, { code: 'XB', from: '2026-07-01', to: '2026-12-31' }],
    incomeByPeriod: [inc(100_000, '2026-03-01', 'XA'), inc(0, '2026-09-01', null, -3_000)],
  }), XB);
  assert.equal(line(r, 'stateIncome')?.cents, -$(3_000));
  assert.deepEqual([r.taxCents, r.balanceCents], [0, 0]);
});

test('the other-state credit under the progressive model; a claimable filer is told the model has no dependent rule', () => {
  // resident all year; 30,000 of 80,000 sourced to XC. 75,000 taxable: 400 + 2,750 = 3,150 − 100 = 3,050; cap 3,050 × 30/80 = 1,143.75
  const base = { code: 'XB', incomeByPeriod: [inc(50_000, '2026-02-01', 'XB'), inc(30_000, '2026-08-01', 'XC')] };
  const r = computeState(input({ ...base, otherStateTaxCents: $(2_000) }), XB);
  assert.equal(line(r, 'otherStateCredit')?.cents, 114375);
  assert.equal(r.taxCents, $(3_050) - 114375);
  assert.match(line(computeState(input({ ...base, claimable: true }), XB), 'standardDeduction')?.assumption ?? '', /no dependent rule/);
});
