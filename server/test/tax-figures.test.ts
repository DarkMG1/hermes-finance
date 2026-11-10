import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { federalFigures, stateFigures } from '../src/tax/figures.ts';

const XA = { model: 'flat', rate: 0.04, exemptionCents: 500_000, dependentExemptionCents: 400_000, supplementalRate: 0.05, source: 'synthetic' };
const XB = { model: 'progressive_ratio', brackets: [[1_000_000, 0.01], [null, 0.05]], standardDeductionCents: 500_000, exemptionCreditCents: 10_000,
  surtax: { overCents: 100_000_000, rate: 0.01 }, movingExpenses: true, source: 'synthetic' };
const stateFile = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'hermes-fig-')), 'states.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};

test('2026 federal figures', () => {
  const r = federalFigures(2026);
  assert.deepEqual([r.year, r.fallback], [2026, false]);
  const f = r.figures;
  assert.deepEqual(f.standardDeduction, { single: 1_610_000, marriedJoint: 3_220_000, headOfHousehold: 2_415_000 });
  assert.deepEqual(f.dependentStandardDeduction, { min: 135_000, addOn: 45_000 });
  assert.deepEqual(f.brackets.single[0], [1_240_000, 0.10]);
  assert.deepEqual(f.brackets.marriedJoint, [[2_480_000, 0.10], [10_080_000, 0.12], [21_140_000, 0.22], [40_355_000, 0.24], [51_245_000, 0.32], [76_870_000, 0.35], [null, 0.37]]);
  assert.deepEqual(f.ltcg, { single: [4_945_000, 54_550_000], marriedJoint: [9_890_000, 61_370_000] });
  assert.deepEqual([f.capitalLossLimit, f.k401Limit, f.ira.limit, f.supplementalRate], [300_000, 2_450_000, 750_000, 0.22]);
  assert.deepEqual(f.socialSecurity, { rate: 0.062, wageBase: 18_450_000 });
});

test('2027 federal figures come from Rev. Proc. 2026-35, carrying the retirement limits it does not publish', () => {
  const r = federalFigures(2027);
  assert.deepEqual([r.year, r.fallback], [2027, false]);
  assert.equal(r.figures.standardDeduction.marriedJoint, 3_320_000);
  assert.deepEqual(r.figures.ltcg.single, [5_105_000, 56_320_000]);
  assert.equal(r.figures.socialSecurity.wageBase, 19_230_000);
  assert.deepEqual(r.figures.carriedFrom2026, ['ira', 'rothPhaseOut', 'k401Limit']);
});

test('a year with no figures falls back to the latest year with fallback true', () => {
  const r = federalFigures(2031);
  assert.deepEqual([r.year, r.fallback], [2027, true]);
});

test('a state file entry parses to its model', () => {
  const file = stateFile({ 2026: { XA, XB } });
  assert.deepEqual(stateFigures(file, 2026, 'XA'), { model: XA, year: 2026, fallback: false });
  assert.deepEqual(stateFigures(file, 2026, 'XB')?.model, XB);
});

test('a malformed state entry is null, not a throw', () => {
  const file = stateFile({ 2026: { XA: { model: 'flat', rate: 'high' }, XB: { ...XB, brackets: 'x' }, XC: { rate: 0.05, source: 'synthetic' } } });
  for (const code of ['XA', 'XB', 'XC', 'XD']) assert.equal(stateFigures(file, 2026, code), null);
  assert.equal(stateFigures(stateFile('not json'), 2026, 'XA'), null);
  assert.equal(stateFigures(join(tmpdir(), 'hermes-no-such-file.json'), 2026, 'XA'), null);
  assert.equal(stateFigures(null, 2026, 'XA'), null);
});

test('a missing year falls back to the latest year in the file', () => {
  const file = stateFile({ 2025: { XA: { ...XA, rate: 0.03 } }, 2026: { XA } });
  assert.deepEqual(stateFigures(file, 2027, 'XA'), { model: XA, year: 2026, fallback: true });
  assert.equal(stateFigures(file, 2025, 'XA')?.fallback, false);
  assert.equal(stateFigures(file, 2024, 'XA'), null);
});

test('a state falls back to its own latest year, not the latest year of any state; a year before the federal ones uses the earliest', () => {
  const file = stateFile({ 2026: { XA }, 2027: { XB } });
  assert.deepEqual(stateFigures(file, 2027, 'XA'), { model: XA, year: 2026, fallback: true });
  assert.deepEqual([federalFigures(2020).year, federalFigures(2020).fallback], [2026, true]);
});
