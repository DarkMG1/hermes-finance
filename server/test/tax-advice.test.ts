import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { advise, type AdviceCtx } from '../src/tax/advice.ts';
import type { Lot } from '../src/tax/lots.ts';
import { federalFigures } from '../src/tax/figures.ts';
import { project, whatIf } from '../src/tax/projection.ts';
import { AUTH, makeTestDeps, seedAccount, seedCategory, seedTxn } from './helpers.ts';

const TODAY = '2026-03-15';
const $ = (dollars: number) => Math.round(dollars * 100);
const STATE_FILE = {
  2026: {
    XA: { model: 'flat', rate: 0.04, exemptionCents: $(5_000), dependentExemptionCents: $(1_000), source: 'synthetic XA' },
    XB: { model: 'progressive_ratio', brackets: [[$(20_000), 0.02], [null, 0.05]], standardDeductionCents: $(5_000), exemptionCreditCents: 0,
      movingExpenses: true, supplementalRate: 0.05, source: 'synthetic XB' },
  },
};
const LIMIT = federalFigures(2026).figures;

async function setup(profile: object = { claimedAsDependent: false }) {
  const { deps } = makeTestDeps();
  const file = join(tmpdir(), `hermes-advice-${process.pid}-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(STATE_FILE));
  deps.config.stateTaxFile = file;
  const app = buildApp(deps);
  let n = 0;
  const send = async (method: 'POST' | 'PUT', url: string, payload: object) => {
    const r = await app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': `k${(n += 1)}` }, payload });
    assert.ok(r.statusCode < 300, `${url} ${r.body}`);
    return r.json();
  };
  await send('PUT', '/v1/profile', { state: 'XA', filingStatus: 'single', fullTimeStudent: false, ...profile });
  return { deps, db: deps.db, send };
}

/** $2,000 (or `gross`) every two weeks, with `federal` withheld per check; open-ended unless `endDate`. */
async function job(send: Awaited<ReturnType<typeof setup>>['send'], federal: number, endDate: string | null = '2026-06-30', gross = 2_000) {
  const j = await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current', startDate: '2025-01-01', ...(endDate && { endDate }) });
  for (const payDate of ['2026-01-09', '2026-01-23', '2026-02-06', '2026-02-20', '2026-03-06']) {
    await send('POST', '/v1/pay-stubs', { jobId: j.id, payDate, grossCents: $(gross), federalCents: $(federal), stateCents: $(80), netCents: $(gross - 80 - federal), state: 'XA' });
  }
}

function roth(db: Db, id: string, taxYear: number, cents: number) {
  db.prepare('INSERT INTO roth_contributions (id, date, amount_cents, tax_year) VALUES (?, ?, ?, ?)').run(id, `${taxYear}-02-01`, cents, taxYear);
}
function security(db: Db, id: string, ticker: string) {
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES (?, ?, ?, 'etf', 0, 'x')").run(id, `Synthetic ${id}`, ticker);
}
let seq = 0;
function buy(db: Db, account: string, sec: string, date: string, quantity: number, costCents: number) {
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, ?, ?, 'buy', 'buy', ?, ?, 'x')")
    .run(`b${(seq += 1)}`, account, sec, date, quantity, costCents);
}
function holding(db: Db, account: string, sec: string, quantity: number, priceCents: number, basisCents: number) {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'x')")
    .run(account, sec, quantity, priceCents, Math.round(quantity * priceCents), basisCents);
}
const kinds = (xs: { kind: string }[]) => xs.map((a) => a.kind);

test('harvest_loss: an unrealized loss saves what the calculator says; a buy in the last 30 days (any account) skips it', async () => {
  const { deps, db, send } = await setup();
  await job(send, 200);
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  security(db, 'sx', 'SYNA');
  buy(db, 'brk', 'sx', '2025-06-01', 10, $(1_500));
  holding(db, 'brk', 'sx', 10, $(100), $(1_500));
  const p = project(deps, 2026, TODAY);
  const h = p.waysToSave.find((a) => a.kind === 'harvest_loss')!;
  const sold = whatIf(deps, 2026, TODAY, { sell: [{ accountId: 'brk', securityId: 'sx', quantity: 10 }] });
  assert.ok(sold.deltaCents > 0);
  assert.equal(h.savingsCents, sold.deltaCents);
  assert.match(h.detail, /within 30 days.*Roth IRA/);
  assert.equal(h.title, 'Sell SYNA in Account brk to harvest a loss');
  assert.match(h.detail, /^Selling all of SYNA in Account brk now realizes a loss \(\$500\.00 short-term\)/);
  // the saving is the drop in tax, not in the balance
  const tax = (x: { returns: { withheldCents: number; balanceCents: number }[] }) => x.returns.reduce((a, r) => a + r.withheldCents - r.balanceCents, 0);
  assert.equal(h.savingsCents, tax(sold.before) - tax(sold.after));
  assert.ok(!/\d/.test(h.askPrompt.replace('SYNA', '')));
  assert.ok(kinds(p.headsUp).includes('harvest_loss'));

  buy(db, 'roth', 'sx', '2026-03-01', 1, $(100));
  assert.ok(!kinds(project(deps, 2026, TODAY).waysToSave).includes('harvest_loss'));
});

test('harvest_loss: a buy already fully sold inside the last 30 days still blocks it', async () => {
  const { deps, db, send } = await setup();
  await job(send, 200);
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  seedAccount(db, { id: 'other', type: 'investment', subtype: 'brokerage' });
  security(db, 'sx', 'SYNA');
  buy(db, 'brk', 'sx', '2025-06-01', 10, $(1_500));
  holding(db, 'brk', 'sx', 10, $(100), $(1_500));
  buy(db, 'other', 'sx', '2026-03-05', 3, $(300));
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES ('s1', 'other', 'sx', '2026-03-10', 'sell', 'sell', -3, ?, 'x')").run(-$(300));
  assert.ok(!kinds(project(deps, 2026, TODAY).waysToSave).includes('harvest_loss'));
});

test('harvest_loss guards: unverified lots, gains and recent buys never reach the what-if', () => {
  const { deps } = makeTestDeps();
  const db = deps.db;
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  security(db, 'sx', 'SYNA');
  holding(db, 'brk', 'sx', 10, $(100), $(1_500));
  let calls = 0;
  const run = (lots: Partial<Lot>[], harvest = true) => {
    calls = 0;
    const l = lots.map((x): Lot => ({ id: 'l', accountId: 'brk', securityId: 'sx', ticker: 'SYNA', acquiredOn: '2025-06-01', quantity: 10, costCents: $(1_500), status: 'known', ...x }));
    const ctx: AdviceCtx = {
      db, year: 2026, fed: LIMIT, safeHarborCents: 0, claimable: false, filingStatus: 'single', birthYear: null,
      projection: { year: 2026, openYears: [2026, 2027], asOf: TODAY, complete: true, combinedBalanceCents: 0, assumptions: [], figures: { federalYear: 2026, fallback: false },
        returns: [{ jurisdiction: 'federal', supported: true, lines: [], taxCents: 0, withheldCents: 0, balanceCents: 0 }], waysToSave: [], headsUp: [] },
      inputs: { year: 2026, tuitionCents: 0, scholarshipsCents: 0, studentLoanInterestCents: 0, k401Cents: null, updatedAt: null }, scenario: null, move: null,
      lots: l, remainingPaychecks: 0, stateModel: () => null, harvest,
      delta: () => { calls += 1; return { savedCents: $(100), sales: [] }; },
    };
    return kinds(advise(ctx, TODAY).waysToSave).includes('harvest_loss');
  };
  assert.equal(run([{}]), true); // control: a known lot at a loss reaches the what-if
  assert.equal(calls, 1);
  assert.equal(run([{ status: 'unverified' }]), false);
  assert.equal(calls, 0);
  assert.equal(run([{ costCents: $(900) }]), false); // price 100 x 10 = 1,000 > cost 900
  assert.equal(calls, 0);
  // held in another account too (a buy there after the sale could wash it), or the heads-up count skipping the what-ifs
  assert.equal(run([{}, { id: 'r', accountId: 'roth', ticker: 'syna' }]), false);
  assert.equal(calls, 0);
  assert.equal(run([{}], false), false);
  assert.equal(calls, 0);
  buy(db, 'brk', 'sx', '2026-03-01', 1, $(100));
  assert.equal(run([{}]), false);
  assert.equal(calls, 0);
});

test('roth_room and over_limit for the open tax years', async () => {
  const { deps, db, send } = await setup();
  await job(send, 200, null);
  roth(db, 'r1', 2026, $(2_000));
  roth(db, 'r0', 2025, LIMIT.ira.limit + $(100));
  const room = project(deps, 2026, TODAY).waysToSave.find((a) => a.kind === 'roth_room')!;
  assert.equal(room.dueDate, '2027-04-15');
  assert.equal(room.savingsCents, null);
  assert.match(room.detail, new RegExp(((LIMIT.ira.limit - $(2_000)) / 100).toLocaleString('en-US')));
  const old = project(deps, 2025, TODAY);
  assert.ok(!kinds(old.waysToSave).includes('roth_room'));
  const over = old.headsUp.find((a) => a.kind === 'over_limit')!;
  assert.equal(over.dueDate, '2026-04-15');
  // after Apr 15 the prior year is closed
  assert.ok(!kinds(project(deps, 2025, '2026-04-16').headsUp).includes('over_limit'));
  // next year counts the scenario's planned contribution
  await send('PUT', '/v1/tax/scenario/2027', { rothCents: $(7_000) });
  const planned = project(deps, 2027, TODAY).waysToSave.find((a) => a.kind === 'roth_room')!;
  assert.match(planned.detail, new RegExp(`put \\$${((LIMIT.ira.limit - $(7_000)) / 100).toLocaleString('en-US')}\\.00 into.*Counts the \\$7,000\\.00 planned in the scenario`));
  await send('PUT', '/v1/tax/scenario/2027', { rothCents: LIMIT.ira.limit + $(1) });
  assert.ok(kinds(project(deps, 2027, TODAY).headsUp).includes('over_limit'));
});

test('roth_room: the limit is capped at taxable pay and phased out by income', async () => {
  const low = await setup();
  await job(low.send, 0, '2026-03-06', 100);
  roth(low.db, 'r1', 2026, $(2_000));
  // 5 stubs of 100 = 500 of pay: 1,500 over
  const over = project(low.deps, 2026, TODAY).headsUp.find((a) => a.kind === 'over_limit')!;
  assert.match(over.detail, /\$1,500\.00 more than your \$500\.00 limit\. Your 2026 limit is your taxable pay/);

  const high = await setup();
  await job(high.send, 0, null, 6_200);
  const p = project(high.deps, 2026, TODAY);
  const agi = p.returns[0]!.lines.find((l) => l.key === 'agi')!.cents;
  const [from, to] = LIMIT.rothPhaseOut.single;
  assert.ok(agi > from && agi < to, String(agi));
  const max = Math.round(LIMIT.ira.limit * (to - agi) / (to - from));
  const room = p.waysToSave.find((a) => a.kind === 'roth_room')!;
  assert.ok(room.detail.includes(`put $${(max / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} into`), room.detail);
  assert.match(room.detail, /phases the limit down/);
});

test('k401_room: next year, only when more would lower the tax; over_limit above the limit', async () => {
  const { deps, send } = await setup();
  await job(send, 200, null);
  await send('PUT', '/v1/tax/scenario/2027', { k401Cents: $(5_000) });
  const p = project(deps, 2027, TODAY);
  const k = p.waysToSave.find((a) => a.kind === 'k401_room')!;
  const full = whatIf(deps, 2027, TODAY, { scenario: { k401Cents: LIMIT.k401Limit } });
  assert.equal(k.savingsCents, full.deltaCents);
  assert.ok(k.savingsCents! > 0);
  assert.ok(!kinds(project(deps, 2026, TODAY).waysToSave).includes('k401_room'));
  await send('PUT', '/v1/tax/scenario/2027', { k401Cents: LIMIT.k401Limit + $(500) });
  const over = project(deps, 2027, TODAY);
  assert.ok(kinds(over.headsUp).includes('over_limit'));
  assert.ok(!kinds(over.waysToSave).includes('k401_room'));
});

test('education_credit: blank tuition asks for it; claimable explains; entered and eligible says nothing', async () => {
  const { deps, send } = await setup();
  const blank = project(deps, 2026, TODAY).waysToSave.find((a) => a.kind === 'education_credit')!;
  assert.equal(blank.title, 'Enter tuition and scholarships');
  assert.equal(blank.savingsCents, null);
  await send('PUT', '/v1/tax/inputs/2026', { tuitionCents: $(4_000) });
  assert.ok(!kinds(project(deps, 2026, TODAY).waysToSave).includes('education_credit'));
  await send('PUT', '/v1/profile', { claimedAsDependent: true });
  assert.match(project(deps, 2026, TODAY).waysToSave.find((a) => a.kind === 'education_credit')!.detail, /claim you/);
});

test('student_loan_interest: blank input with a loan payment in the year', async () => {
  const { deps, db, send } = await setup();
  seedAccount(db, { id: 'chk' });
  seedCategory(db, { id: 'c1', name: 'Student Loan' });
  seedTxn(db, { id: 't1', accountId: 'chk', date: '2026-02-01', amountCents: -$(200), categoryId: 'c1' });
  const a = project(deps, 2026, TODAY).waysToSave.find((x) => x.kind === 'student_loan_interest')!;
  assert.equal(a.title, 'Enter student loan interest');
  await send('PUT', '/v1/tax/inputs/2026', { studentLoanInterestCents: 0 });
  assert.ok(!kinds(project(deps, 2026, TODAY).waysToSave).includes('student_loan_interest'));
  assert.ok(!kinds(project(deps, 2027, TODAY).waysToSave).includes('student_loan_interest'));
});

test("moving_expenses: next year's move into a state that allows the deduction", async () => {
  const { deps, send } = await setup();
  await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2027-03-01', moveTo: 'XA' });
  assert.ok(!kinds(project(deps, 2027, TODAY).waysToSave).includes('moving_expenses'));
  await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2027-03-01', moveTo: 'XB' });
  const m = project(deps, 2027, TODAY).waysToSave.find((a) => a.kind === 'moving_expenses')!;
  assert.match(m.detail, /deduct moving costs the employer didn't pay/);
  assert.equal(m.savingsCents, null);
});

test('estimated_payment and withholding_short are per return, naming the form that fixes each', async () => {
  const { deps, send } = await setup();
  await job(send, 0, '2026-06-30', 8_000);
  const soon = '2026-04-01';
  const p = project(deps, 2026, soon);
  const [fed, xa] = p.returns;
  assert.ok(fed!.balanceCents < -$(1_000) && xa!.balanceCents < -$(1_000));
  assert.deepEqual(p.headsUp.filter((a) => a.kind === 'estimated_payment').map((a) => [a.title, a.dueDate]),
    [['Estimated federal tax payment due soon', '2026-04-15'], ['Estimated XA tax payment due soon', '2026-04-15']]);
  const [w, ws] = p.headsUp.filter((a) => a.kind === 'withholding_short');
  const n = Number(w!.detail.match(/of the (\d+) remaining/)![1]);
  assert.ok(w!.detail.includes(`$${Math.ceil(-fed!.balanceCents / n / 100)} more`) && w!.detail.endsWith('Change it on your W-4.'), w!.detail);
  assert.ok(ws!.title.startsWith('XA withholding is short') && ws!.detail.includes(`$${Math.ceil(-xa!.balanceCents / n / 100)} more`)
    && ws!.detail.endsWith('Change it on your XA withholding certificate.'), ws!.detail);
  // not within 30 days of a due date: no estimated payment item
  assert.ok(!kinds(project(deps, 2026, '2026-05-10').headsUp).includes('estimated_payment'));
});

test('a refund on one return never hides a shortfall on another; a closed year and an unsupported state get no withholding alert', async () => {
  const { deps, send } = await setup();
  // federal well over-withheld, XA under-withheld
  const j = await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current', startDate: '2025-01-01', endDate: '2026-06-30' });
  for (const payDate of ['2026-01-09', '2026-01-23', '2026-02-06', '2026-02-20', '2026-03-06']) {
    await send('POST', '/v1/pay-stubs', { jobId: j.id, payDate, grossCents: $(8_000), federalCents: $(3_000), stateCents: 0, netCents: $(5_000), state: 'XA' });
  }
  const p = project(deps, 2026, TODAY);
  assert.ok(p.combinedBalanceCents > 0);
  assert.deepEqual(p.headsUp.filter((a) => a.kind === 'withholding_short').map((a) => a.title.split(' ')[0]), ['XA']);
  // last year: no paychecks left to change
  await send('POST', '/v1/pay-stubs', { jobId: j.id, payDate: '2025-12-19', grossCents: $(8_000), federalCents: 0, stateCents: 0, netCents: $(8_000), state: 'XA' });
  assert.ok(!kinds(project(deps, 2025, TODAY).headsUp).includes('withholding_short'));
  // a state with no figures: no alert, and the projection says why
  await send('PUT', '/v1/profile', { state: 'XC' });
  const xc = project(deps, 2026, TODAY);
  assert.deepEqual([xc.complete, xc.headsUp.some((a) => a.title.startsWith('XC'))], [false, false]);
  assert.ok(xc.assumptions.includes("XC not supported: its tax isn't in the total") && xc.assumptions.includes("Withholding alerts skip XC: its tax isn't known"));
});

test('ask prompts never hold amounts', async () => {
  const { deps, db, send } = await setup();
  await job(send, 0, '2026-06-30', 8_000);
  roth(db, 'r1', 2026, $(100_000));
  await send('PUT', '/v1/tax/scenario/2027', { k401Cents: $(1_000), moveDate: '2027-03-01', moveTo: 'XB' });
  const items = [2026, 2027].flatMap((y) => { const p = project(deps, y, '2026-04-01'); return [...p.waysToSave, ...p.headsUp]; });
  assert.ok(items.length >= 5, String(items.length));
  for (const a of items) assert.ok(!a.askPrompt.includes('$'), a.askPrompt);
});

test('estimated_payment needs a lot owed AND withholding under the safe harbor; a refund never triggers it', async () => {
  const { deps, send } = await setup();
  await job(send, 200);
  // projected refund (withholding 10% is well above the tax) with a 2025 safe harbor above the 2026 withholding
  await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', totalTaxCents: $(50_000), agiCents: $(20_000) });
  const refund = project(deps, 2026, '2026-04-01');
  assert.ok(refund.combinedBalanceCents > 0);
  assert.ok(!kinds(refund.headsUp).includes('estimated_payment'));
});

test('estimated_payment: owed over $1,000 with withholding under the safe harbor and a due date within 30 days', async () => {
  const { deps, send } = await setup();
  await job(send, 80, '2026-06-30', 4_000);
  await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', totalTaxCents: $(50_000), agiCents: $(20_000) });
  const p = project(deps, 2026, '2026-04-01');
  assert.ok(p.returns[0]!.balanceCents < -$(1_000));
  assert.equal(p.headsUp.find((a) => a.kind === 'estimated_payment')?.dueDate, '2026-04-15');
  // owed, but withholding already meets the safe harbor (prior tax tiny): no item
  await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', totalTaxCents: $(100), agiCents: $(20_000) });
  assert.ok(!kinds(project(deps, 2026, '2026-04-01').headsUp).includes('estimated_payment'));
});

test('no advice on a clean year', async () => {
  const { deps, db, send } = await setup();
  await job(send, 400);
  await send('PUT', '/v1/tax/inputs/2026', { tuitionCents: 0 });
  roth(db, 'r1', 2026, LIMIT.ira.limit);
  const p = project(deps, 2026, TODAY);
  assert.ok(p.combinedBalanceCents > 0);
  assert.deepEqual([p.waysToSave, p.headsUp], [[], []]);
});
