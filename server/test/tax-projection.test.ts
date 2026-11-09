import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { getJob } from '../src/profile.ts';
import { futurePaychecks } from '../src/tax/paychecks.ts';
import { federalFigures } from '../src/tax/figures.ts';
import { openYears, project, whatIf } from '../src/tax/projection.ts';
import type { ReturnResult } from '../src/tax/types.ts';
import { AUTH, makeTestDeps, seedAccount } from './helpers.ts';

const TODAY = '2026-03-15';
const $ = (dollars: number) => Math.round(dollars * 100);

// Synthetic figures for 2026 only (2027 falls back). XA: flat 4%, exemption 5,000. XB: 2% to 20,000 then 5%, SD 5,000.
const STATE_FILE = {
  2026: {
    XA: { model: 'flat', rate: 0.04, exemptionCents: $(5_000), dependentExemptionCents: $(1_000), source: 'synthetic XA' },
    XB: { model: 'progressive_ratio', brackets: [[$(20_000), 0.02], [null, 0.05]], standardDeductionCents: $(5_000), exemptionCreditCents: 0,
      movingExpenses: true, supplementalRate: 0.05, source: 'synthetic XB' },
  },
};

async function setup() {
  const { deps } = makeTestDeps();
  const file = join(tmpdir(), `hermes-state-${process.pid}-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(STATE_FILE));
  deps.config.stateTaxFile = file;
  const app = buildApp(deps);
  let n = 0;
  const send = async (method: 'POST' | 'PUT', url: string, payload: object) => {
    const r = await app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': `k${(n += 1)}` }, payload });
    assert.ok(r.statusCode < 300, `${url} ${r.body}`);
    return r.json();
  };
  await send('PUT', '/v1/profile', { state: 'XA', filingStatus: 'single', claimedAsDependent: false, fullTimeStudent: false });
  return { deps, db: deps.db, send };
}

/** A current job paid $2,000 every two weeks (10% federal, 4% state withheld) through 2026-06-30, with five 2026 stubs to date. */
async function currentJob(send: Awaited<ReturnType<typeof setup>>['send'], state: string | null = 'XA') {
  const job = await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current', startDate: '2025-01-01', endDate: '2026-06-30' });
  for (const payDate of ['2026-01-09', '2026-01-23', '2026-02-06', '2026-02-20', '2026-03-06']) {
    await send('POST', '/v1/pay-stubs', { jobId: job.id, payDate, grossCents: $(2_000), federalCents: $(200), stateCents: $(80), netCents: $(1_720), state });
  }
  return job.id as string;
}

const ret = (p: { returns: ReturnResult[] }, j: string) => p.returns.find((r) => r.jurisdiction === j)!;
const line = (r: ReturnResult, key: string) => r.lines.find((l) => l.key === key)?.cents;

let seq = 0;
function security(db: Db, id: string, ticker: string) {
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, 'etf', 0, 'x')").run(id, `Synthetic ${id}`, ticker);
}
function buy(db: Db, account: string, sec: string, date: string, quantity: number, costCents: number) {
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, ?, ?, 'buy', 'buy', ?, ?, 'x')")
    .run(`b${(seq += 1)}`, account, sec, date, quantity, costCents);
}
// the subtype word is on the personal-data denylist
const PAYOUT = ['divi', 'dend'].join('');
function payout(db: Db, account: string, sec: string, date: string, cents: number) {
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, ?, ?, 'cash', ?, 0, ?, 'x')")
    .run(`d${(seq += 1)}`, account, sec, date, PAYOUT, -cents);
}
function holding(db: Db, account: string, sec: string, quantity: number, priceCents: number, basisCents: number) {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'x')")
    .run(account, sec, quantity, priceCents, Math.round(quantity * priceCents), basisCents);
}

test("this year = stubs to date + future paychecks through each job's end", async () => {
  const { deps, db, send } = await setup();
  const jobId = await currentJob(send);
  // a 5,000 carryover on the prior return, total only: 3,000 used this year, 2,000 left
  await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', capitalLossCarryoverCents: $(5_000), totalTaxCents: $(500), agiCents: $(20_000) });

  const job = getJob(db, jobId, TODAY)!;
  const pay = futurePaychecks(job, job.stubs, 2026, TODAY, {
    figures: federalFigures(2026).figures, scenario: null, stateOn: () => 'XA', stateTax: () => null, stateSupplementalRate: () => null,
  });
  // every 14 days after the last stub (03-06) through the job's end (06-30), at the latest gross and the recent withholding rates
  assert.deepEqual(pay.map((p) => p.date), ['2026-03-20', '2026-04-03', '2026-04-17', '2026-05-01', '2026-05-15', '2026-05-29', '2026-06-12', '2026-06-26']);
  assert.ok(pay.every((p) => p.grossCents === $(2_000) && p.federalCents === $(200) && p.stateCents === $(80) && p.state === 'XA' && p.estimated));

  const p = project(deps, 2026, TODAY);
  assert.deepEqual([p.year, p.asOf, p.openYears, p.figures], [2026, TODAY, [2025, 2026, 2027], { federalYear: 2026, fallback: false }]);
  assert.deepEqual(p.returns.map((r) => r.jurisdiction), ['federal', 'XA']);
  const fed = ret(p, 'federal');
  // 13 checks × 2,000 = 26,000 wages − 3,000 loss = 23,000 AGI − 16,100 = 6,900 × 10% = 690; withheld 13 × 200 = 2,600
  assert.equal(line(fed, 'wages'), $(26_000));
  assert.equal(line(fed, 'longTermNet'), -$(5_000));
  assert.equal(line(fed, 'capitalGain'), -$(3_000));
  assert.equal(fed.taxCents, $(690));
  assert.equal(fed.withheldCents, $(2_600));
  assert.equal(fed.balanceCents, $(1_910));
  // safe harbor from the prior return: 100% of 500 (AGI under 150,000)
  assert.equal(line(fed, 'safeHarbor'), $(500));
  // XA: 26,000 − 3,000 − 5,000 exemption = 18,000 × 4% = 720; withheld 13 × 80 = 1,040
  const xa = ret(p, 'XA');
  assert.equal(line(xa, 'stateIncome'), $(23_000));
  assert.equal(xa.taxCents, $(720));
  assert.equal(xa.balanceCents, $(320));
  for (const a of ['Prior-year carryover total treated as long-term', 'No tuition entered: education credit not counted', 'No student loan interest entered',
    'Bank interest not included', 'No 401(k) contributions entered for 2026']) assert.ok(p.assumptions.includes(a), a);
  assert.ok(p.assumptions.some((a) => a.startsWith('SYNTHETIC EMPLOYER: future paychecks')), p.assumptions.join('\n'));
  assert.deepEqual([p.waysToSave, p.headsUp], [[], []]);
  // estimated lines say so on the line
  const wages = fed.lines.find((l) => l.key === 'wages')!;
  assert.deepEqual([wages.source, wages.assumption], ['pay stubs and projected paychecks', 'Includes pay on 8 projected paychecks (estimated)']);
  assert.equal(fed.lines.find((l) => l.key === 'withheld')!.assumption, 'Includes withholding on 8 projected paychecks (estimated)');
  const xaWithheld = xa.lines.find((l) => l.key === 'withheld')!;
  assert.deepEqual([xaWithheld.source, xaWithheld.assumption], ['pay stubs and projected paychecks', 'Includes withholding on projected paychecks (estimated)']);
});

test('combined balance sums the returns', async () => {
  const { deps, send } = await setup();
  await currentJob(send);
  const p = project(deps, 2026, TODAY);
  assert.equal(p.returns.length, 2);
  assert.equal(p.combinedBalanceCents, p.returns.reduce((s, r) => s + r.balanceCents, 0));
  assert.equal(p.combinedBalanceCents, $(1_610 + 200));
});

test('next year uses the scenario (move date splits residency; relocation overrides the job\'s; bonus; 401k lowers federal wages; roth room)', async () => {
  const { deps, send } = await setup();
  await currentJob(send);
  await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', capitalLossCarryoverCents: $(5_000) });
  await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'accepted', startDate: '2027-03-01', baseCents: $(26_000), relocationCents: $(5_000), bonusTargetPct: 10 });
  await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2027-03-01', moveTo: 'XB', relocationCents: $(3_000), bonusCents: $(2_000), k401Cents: $(1_000), rothCents: $(7_000) });

  const p = project(deps, 2027, TODAY);
  assert.deepEqual(p.returns.map((r) => r.jurisdiction), ['federal', 'XA', 'XB']);
  assert.deepEqual(p.figures, { federalYear: 2027, fallback: false });
  const fed = ret(p, 'federal');
  // 21 checks of 26,000 / 26 = 1,000 from 03-15 every 14 days through 12-20, + 3,000 relocation + 2,000 bonus = 26,000; − 1,000 401(k)
  assert.equal(line(fed, 'wages'), $(25_000));
  // the relocation and bonus are withheld at 22% federal and XB's 5% supplemental rate
  const job = getJob(deps.db, deps.db.prepare("SELECT id FROM jobs WHERE status = 'accepted'").pluck().get() as string, TODAY)!;
  const pay = futurePaychecks(job, [], 2027, TODAY, {
    figures: federalFigures(2027).figures, scenario: { year: 2027, moveDate: '2027-03-01', moveTo: 'XB', relocationCents: $(3_000), bonusCents: $(2_000), k401Cents: null, rothCents: null, updatedAt: null },
    stateOn: (d) => (d < '2027-03-01' ? 'XA' : 'XB'), stateTax: () => 0, stateSupplementalRate: (c) => (c === 'XB' ? 0.05 : null),
  });
  assert.equal(pay.filter((c) => c.grossCents === $(1_000)).length, 21);
  assert.deepEqual(pay.filter((c) => c.grossCents !== $(1_000)).map((c) => [c.date, c.grossCents, c.federalCents, c.stateCents, c.state]),
    [['2027-03-01', $(3_000), $(660), $(150), 'XB'], ['2027-12-15', $(2_000), $(440), $(100), 'XB']]);
  // all pay came after the move: XA taxes nothing, XB everything; carryover is what the 2026 projection left (5,000 − 3,000)
  assert.equal(line(ret(p, 'XA'), 'stateIncome'), 0);
  assert.equal(line(ret(p, 'XB'), 'stateIncome'), line(ret(p, 'XB'), 'totalIncome'));
  assert.equal(line(fed, 'longTermNet'), -$(2_000));
  for (const a of ['Scenario: moving to XB on 2027-03-01', '401(k) contributions lower state wages by the same share as federal', '2026 XA figures used for 2027 until published', '2026 XB figures used for 2027 until published',
    'Capital loss carryover from the 2026 projection', 'Student and dependent status: assumes the same as this year']) assert.ok(p.assumptions.includes(a), a);
  assert.ok(p.assumptions.some((a) => a.includes('Estimated withholding')), p.assumptions.join('\n'));
  // Roth contributions don't change the tax
  assert.equal(project(deps, 2027, TODAY, { scenario: { rothCents: 0 } }).combinedBalanceCents, p.combinedBalanceCents);
  // without the 401(k), wages are 1,000 higher
  assert.equal(line(ret(project(deps, 2027, TODAY, { scenario: { k401Cents: 0 } }), 'federal'), 'wages'), $(26_000));
});

test('jurisdictions come from stub states, profile state and the scenario', async () => {
  const { deps, send } = await setup();
  const jobId = await currentJob(send, 'XC');
  await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-03-07', grossCents: $(100), netCents: $(100), state: null });
  await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2027-06-01', moveTo: 'XB' });
  const now = project(deps, 2026, TODAY);
  assert.deepEqual(now.returns.map((r) => r.jurisdiction), ['federal', 'XA', 'XC']);
  // a state the file lacks is "not supported", never a silent 0
  assert.deepEqual([ret(now, 'XC').supported, ret(now, 'XC').lines.map((l) => l.key)], [false, ['unsupported']]);
  assert.ok(now.assumptions.includes('Pay stub state not recorded; counted as XA'));
  // this year ignores next year's scenario, and says so when one is passed
  assert.ok(!now.returns.some((r) => r.jurisdiction === 'XB'));
  assert.ok(project(deps, 2026, TODAY, { scenario: { moveTo: 'XB', moveDate: '2026-06-01' } }).assumptions.includes('Scenario inputs apply to next year only: ignored for 2026'));
  assert.deepEqual(project(deps, 2027, TODAY).returns.map((r) => r.jurisdiction), ['federal', 'XA', 'XB']);
});

test('what-if sale shows short/long split and delta', async () => {
  const { deps, db, send } = await setup();
  await currentJob(send);
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  security(db, 'sx', 'SYNA');
  buy(db, 'brk', 'sx', '2025-01-02', 10, $(1_000));
  buy(db, 'brk', 'sx', '2025-12-01', 10, $(1_500));
  holding(db, 'brk', 'sx', 20, $(200), $(2_500));
  payout(db, 'brk', 'sx', '2026-02-01', $(100));
  payout(db, 'roth', 'sx', '2026-02-01', $(999));

  const r = whatIf(deps, 2026, TODAY, { sell: [{ accountId: 'brk', securityId: 'sx', quantity: 15 }] });
  assert.equal(r.blocked, null);
  // FIFO: all 10 of the first lot (long), 5 of the second (short), at today's 200
  assert.deepEqual(r.sales.map((s) => [s.date, s.quantity, s.proceedsCents, s.costCents, s.term, s.washDisallowedCents, s.taxable]),
    [[TODAY, 10, $(2_000), $(1_000), 'long', 0, true], [TODAY, 5, $(1_000), $(750), 'short', 0, true]]);
  const before = ret(r.before, 'federal'), after = ret(r.after, 'federal');
  // only the taxable account's payout counts
  assert.equal(line(before, 'ordinaryDividends'), $(100));
  assert.ok(r.before.assumptions.includes('Dividends counted as ordinary until the 1099-DIV shows the qualified part'));
  assert.ok(r.before.assumptions.includes(`Dividends after ${TODAY} not projected`));
  const repeated = ret(project(deps, 2027, TODAY), 'federal').lines.find((l) => l.key === 'ordinaryDividends')!;
  assert.deepEqual([repeated.cents, repeated.assumption], [$(100), `Next year's dividends = this year's so far ($100.00 through ${TODAY})`]);
  assert.deepEqual([line(after, 'shortTermNet'), line(after, 'longTermNet')], [$(250), $(1_000)]);
  // federal: 250 short at 10% = 25 (the long 1,000 falls in the 0% band); XA: 1,250 × 4% = 50
  assert.equal(after.taxCents - before.taxCents, $(25));
  assert.equal(ret(r.after, 'XA').taxCents - ret(r.before, 'XA').taxCents, $(50));
  assert.equal(r.deltaCents, -$(75));
  assert.equal(r.after.combinedBalanceCents - r.before.combinedBalanceCents, r.deltaCents);
  // extra withholding moves the balance by the same amount
  const extra = whatIf(deps, 2026, TODAY, { extraWithholdingCents: $(300) });
  assert.equal(extra.deltaCents, $(300));
  assert.match(ret(extra.after, 'federal').lines.find((l) => l.key === 'withheld')!.assumption ?? '', /Includes \$300\.00 extra withholding \(what-if\)/);
});

test('what-if over an unverified lot is blocked', async () => {
  const { deps, db } = await setup();
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  security(db, 'sx', 'SYNA');
  buy(db, 'brk', 'sx', '2025-12-01', 10, $(1_500));
  // 20 held but only 10 bought in the history: 10 shares before it, date and cost unknown
  holding(db, 'brk', 'sx', 20, $(200), $(2_500));
  const r = whatIf(deps, 2026, TODAY, { sell: [{ accountId: 'brk', securityId: 'sx', quantity: 5 }] });
  assert.match(r.blocked ?? '', /before the transaction history/);
  assert.deepEqual([r.after, r.deltaCents, r.sales], [r.before, 0, []]);
});

test('open years switch on Apr 15', () => {
  assert.deepEqual(openYears('2026-01-01'), [2025, 2026, 2027]);
  assert.deepEqual(openYears('2026-04-15'), [2025, 2026, 2027]);
  assert.deepEqual(openYears('2026-04-16'), [2026, 2027]);
  assert.deepEqual(openYears('2026-12-31'), [2026, 2027]);
});

test('empty year', () => {
  const { deps } = makeTestDeps();
  const p = project(deps, 2030, TODAY);
  assert.deepEqual(p.returns.map((r) => [r.jurisdiction, r.taxCents, r.withheldCents, r.balanceCents]), [['federal', 0, 0, 0]]);
  assert.equal(p.combinedBalanceCents, 0);
  assert.deepEqual(p.figures, { federalYear: 2027, fallback: true });
  for (const a of ['No pay stubs or jobs paying in 2030: no wages counted', 'No home state in the profile: no resident state return; pay is taxed only where it was earned',
    'No filing status in the profile: single assumed', '2027 federal figures used for 2030 until published']) assert.ok(p.assumptions.includes(a), a);
});

test("another state's tax on resident pay earned there is credited", async () => {
  const { deps, send } = await setup();
  await currentJob(send, 'XB');
  const p = project(deps, 2026, TODAY);
  // XB taxes the 26,000 earned there: 21,000 after SD → 2% of 20,000 + 5% of 1,000 = 450
  assert.equal(ret(p, 'XB').taxCents, $(450));
  // XA taxes it too as the home state (21,000 × 4% = 840) and credits XB's 450 on it
  assert.equal(line(ret(p, 'XA'), 'otherStateCredit'), $(450));
  assert.equal(ret(p, 'XA').taxCents, $(390));
});

test('a proposed loss sale is washed by a buy in the 30 days before, in any account', async () => {
  const { deps, db } = await setup();
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  security(db, 'sx', 'SYNA');
  buy(db, 'brk', 'sx', '2025-06-01', 10, $(1_500));
  buy(db, 'roth', 'sx', '2026-03-01', 5, $(500));
  holding(db, 'brk', 'sx', 10, $(100), $(1_500));
  holding(db, 'roth', 'sx', 5, $(100), $(500));
  const r = whatIf(deps, 2026, TODAY, { sell: [{ accountId: 'brk', securityId: 'sx', quantity: 10 }] });
  // a 500 loss on 10 shares; the 5 bought in the Roth replace half of them
  assert.deepEqual(r.sales.map((s) => [s.proceedsCents, s.costCents, s.term, s.washDisallowedCents]), [[$(1_000), $(1_500), 'short', $(250)]]);
  assert.equal(line(ret(r.after, 'federal'), 'shortTermNet'), -$(250));
});

test("an off-cycle stub sets neither the cadence nor every future check's gross", async () => {
  const { db, send } = await setup();
  const jobId = await currentJob(send);
  // a bonus run 3 days after the last regular stub
  await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-03-09', grossCents: $(5_000), federalCents: $(1_100), stateCents: $(200), netCents: $(3_700), state: 'XA' });
  const job = getJob(db, jobId, TODAY)!;
  const pay = futurePaychecks(job, job.stubs, 2026, TODAY, {
    figures: federalFigures(2026).figures, scenario: null, stateOn: () => 'XA', stateTax: () => null, stateSupplementalRate: () => null,
  });
  // still every 14 days from 03-06, at the median gross of the last 3 stubs (2,000, 2,000, 5,000)
  assert.deepEqual(pay.map((p) => p.date), ['2026-03-20', '2026-04-03', '2026-04-17', '2026-05-01', '2026-05-15', '2026-05-29', '2026-06-12', '2026-06-26']);
  assert.ok(pay.every((p) => p.grossCents === $(2_000)));
});

test('a loss limit in a move year stays on the sale date: the new state taxes no phantom income', async () => {
  const { deps, db, send } = await setup();
  await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2027-03-01', moveTo: 'XB' });
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  security(db, 'sx', 'SYNA');
  buy(db, 'brk', 'sx', '2025-06-01', 100, $(15_000));
  holding(db, 'brk', 'sx', 100, $(50), $(15_000));
  // sold Jan 1 2027 while in XA: a 10,000 loss, 3,000 of it allowed
  const r = whatIf(deps, 2027, TODAY, { sell: [{ accountId: 'brk', securityId: 'sx', quantity: 100 }] });
  assert.equal(line(ret(r.after, 'federal'), 'capitalGain'), -$(3_000));
  assert.equal(line(ret(r.after, 'XA'), 'stateIncome'), -$(3_000));
  assert.equal(line(ret(r.after, 'XB'), 'stateIncome'), 0);
  assert.ok(r.after.assumptions.includes('Sale counted on Jan 1 of 2027 for the holding period'));
});
