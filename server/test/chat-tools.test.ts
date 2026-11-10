import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { RESULT_MAX, TOOLS, runTool, type ToolContext } from '../src/chat/tools.ts';
import { toolLabel } from '../src/chat/labels.ts';
import { getExpenses, getSpending } from '../src/cashflow.ts';
import { getNetWorth, localDay } from '../src/networth.ts';
import { getInvestments } from '../src/investments.ts';
import { getRecurring } from '../src/recurring.ts';
import { listAccounts, listTransactions } from '../src/ledger.ts';
import { getPerson, listPeople } from '../src/people.ts';
import { getJob, getProfile, listJobs, taxYears } from '../src/profile.ts';
import { project, whatIf } from '../src/tax/projection.ts';
import { buildLots, lotsView } from '../src/tax/lots.ts';
import { linkDocument, saveDocument } from '../src/documents.ts';
import { makeTestDeps, seedAccount, seedCategory, seedPerson, seedTxn } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1', subtype: 'checking', balanceCents: 100000 });
  seedCategory(deps.db, { id: 'c-food', name: 'Food' });
  seedPerson(deps.db, { id: 'p1', name: 'Synthetic Quill' });
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-03-02', amountCents: -1500, categoryId: 'c-food', payee: 'SYNTHETIC GROCER' });
  seedTxn(deps.db, { id: 't2', accountId: 'a1', date: '2026-03-05', amountCents: -2500, categoryId: 'c-food', payee: 'SYNTHETIC GROCER' });
  return { deps, db: deps.db, today: localDay(deps.now()) };
}
const call = (deps: ReturnType<typeof setup>['deps'], name: string, input: unknown, ctx?: ToolContext) => JSON.parse(runTool(deps, name, input, ctx).content);
const UNLOCKED = { profileUnlocked: true };

test('spending tool returns exactly getSpending', () => {
  const { deps, db } = setup();
  assert.deepEqual(call(deps, 'spending', { period: 'month', date: '2026-03' }), getSpending(db, { period: 'month', date: '2026-03' }));
});

test('transactions, people, net_worth, bills, accounts match the functions the routes use', () => {
  const { deps, db, today } = setup();
  assert.deepEqual(call(deps, 'transactions', { limit: 1 }), JSON.parse(JSON.stringify(listTransactions(db, { limit: 1 }, today))));
  assert.deepEqual(call(deps, 'people', {}), listPeople(db, true));
  assert.deepEqual(call(deps, 'net_worth', { range: '1m' }), getNetWorth(db, '1m', today));
  assert.deepEqual(call(deps, 'bills', {}), JSON.parse(JSON.stringify(getRecurring(db, today, false))));
  assert.deepEqual(call(deps, 'accounts', {}), listAccounts(db));
});

test('net_worth filtered by account ids or type matches getNetWorth with that filter', () => {
  const { deps, db, today } = setup();
  seedAccount(db, { id: 'cc', type: 'credit', balanceCents: 30000 });
  db.prepare('INSERT INTO balance_snapshots (account_id, date, balance_cents) VALUES (\'a1\', ?, 100000), (\'cc\', ?, 30000)').run(today, today);
  const one = call(deps, 'net_worth', { range: '1m', accountIds: ['cc'] });
  assert.deepEqual(one, getNetWorth(db, '1m', today, { accountIds: ['cc'] }));
  assert.equal(one.currentCents, -30000);
  assert.deepEqual(call(deps, 'net_worth', { range: '3m', type: 'depository' }), getNetWorth(db, '3m', today, { type: 'depository' }));
  assert.equal(runTool(deps, 'net_worth', { range: '1m', accountIds: [] }).isError, true);
});

test('bad input is an error result, not a throw', () => {
  const { deps } = setup();
  const r = runTool(deps, 'spending', { period: 'month', date: 'September' });
  assert.equal(r.isError, true);
  assert.match(r.content, /date/);
});

test('unknown tool and missing transaction are error results', () => {
  const { deps } = setup();
  assert.equal(runTool(deps, 'nope', {}).isError, true);
  assert.equal(runTool(deps, 'transaction', { id: 'missing' }).isError, true);
  assert.equal(runTool(deps, 'people', { id: 'missing' }).isError, true);
  assert.equal(runTool(deps, 'transaction', { id: 't1' }).isError, false);
});

test('large results are cut', () => {
  const { deps, db } = setup();
  for (let i = 0; i < 300; i++) seedTxn(db, { id: `m${i}`, accountId: 'a1', date: '2026-02-01', amountCents: -100, payee: 'SYNTHETIC GROCER WITH A LONG NAME' });
  const r = runTool(deps, 'transactions', { limit: 200 });
  assert.ok(r.content.length <= RESULT_MAX + 200);
  assert.equal(JSON.parse(r.content).truncated, true);
});

test('every TOOLS entry has an object input_schema and a runTool branch', () => {
  const { deps } = setup();
  for (const t of TOOLS) {
    assert.equal(t.input_schema.type, 'object', t.name);
    assert.ok(!('$schema' in t.input_schema), t.name);
    assert.ok(!/unknown tool/.test(runTool(deps, t.name, {}).content), t.name);
  }
});

test('toolLabel', () => {
  assert.equal(toolLabel('spending', { period: 'month', date: '2026-09' }), 'Spending · September 2026');
  assert.equal(toolLabel('spending', { period: 'year', date: '2026' }), 'Spending · 2026');
  assert.equal(toolLabel('accounts', {}), 'Accounts');
});

test('a cut page keeps a cursor that continues with no gap or duplicate', () => {
  const { deps, db } = setup();
  for (let i = 0; i < 300; i++) seedTxn(db, { id: `m${String(i).padStart(3, '0')}`, accountId: 'a1', date: '2026-02-01', amountCents: -100, payee: 'SYNTHETIC GROCER WITH A LONG NAME' });
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const r = JSON.parse(runTool(deps, 'transactions', { limit: 200, from: '2026-02-01', to: '2026-02-01', ...(cursor ? { cursor } : {}) }).content);
    ids.push(...r.transactions.map((t: { id: string }) => t.id));
    cursor = r.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.length, 300);
  assert.equal(new Set(ids).size, 300);
  assert.deepEqual(ids, [...ids].sort().reverse());
});

test('results always fit the cap, even quote-heavy ones', () => {
  const { deps, db } = setup();
  for (let i = 0; i < 40; i++) seedTxn(db, { id: `q${i}`, accountId: 'a1', date: '2026-02-01', amountCents: -100, payee: '"'.repeat(150), bankDescription: '\\"'.repeat(400) });
  for (const input of [{ limit: 200 }, { limit: 1 }]) {
    const c = runTool(deps, 'transactions', input).content;
    assert.ok(c.length <= RESULT_MAX);
    if (input.limit === 200) assert.equal(JSON.parse(c).truncated, true);
  }
});

test('toolLabel shows a date range', () => {
  assert.equal(toolLabel('transactions', { from: '2026-09-01', to: '2026-09-30' }), 'Transactions · 2026-09-01 – 2026-09-30');
  assert.equal(toolLabel('transactions', { from: '2026-03-01' }), 'Transactions · Since 2026-03-01');
  assert.equal(toolLabel('transactions', { to: '2026-03-31' }), 'Transactions · Through 2026-03-31');
});

test('investments and expenses match their functions', () => {
  const { deps, db } = setup();
  assert.deepEqual(call(deps, 'investments', {}), JSON.parse(JSON.stringify(getInvestments(db))));
  const q = { period: 'month' as const, date: '2026-03', kind: 'out' as const, limit: 50 };
  assert.deepEqual(call(deps, 'expenses', { period: 'month', date: '2026-03' }), getExpenses(db, q));
});

test('people lists archived people too (the app always asks with all=1)', () => {
  const { deps, db } = setup();
  seedPerson(db, { id: 'p2', name: 'Synthetic Wren', archived: true });
  assert.deepEqual(call(deps, 'people', {}).map((p: { id: string }) => p.id).sort(), ['p1', 'p2']);
});

test('a cut net worth history keeps the newest points', () => {
  const { deps, db, today } = setup();
  db.prepare("INSERT INTO balance_snapshots VALUES ('a1', '2024-01-01', 1000)").run();
  const full = getNetWorth(db, 'all', today);
  assert.ok(JSON.stringify(full).length > RESULT_MAX);
  const r = runTool(deps, 'net_worth', { range: 'all' });
  assert.ok(r.content.length <= RESULT_MAX);
  const got = JSON.parse(r.content);
  assert.equal(got.truncated, true);
  assert.equal(got.points.at(-1).date, full.points.at(-1)!.date);
  assert.ok(got.points.length < full.points.length);
});

test('a single transaction over the cap is delivered with its amounts and shortened text, and the cursor goes on from it', () => {
  const { deps, db } = setup();
  seedTxn(db, { id: 'huge', accountId: 'a1', date: '2026-02-02', amountCents: -4321, payee: 'SYNTHETIC GROCER', bankDescription: 'SYNTHETIC '.repeat(3000) });
  seedTxn(db, { id: 'older', accountId: 'a1', date: '2026-02-01', amountCents: -100, payee: 'SYNTHETIC GROCER' });
  const first = JSON.parse(runTool(deps, 'transactions', { to: '2026-02-28', limit: 200 }).content);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.transactions.map((t: { id: string }) => t.id), ['huge']);
  assert.equal(first.transactions[0].amountCents, -4321);
  assert.ok(first.transactions[0].bankDescription.length < 600);
  const next = JSON.parse(runTool(deps, 'transactions', { to: '2026-02-28', limit: 200, cursor: first.nextCursor }).content);
  assert.deepEqual(next.transactions.map((t: { id: string }) => t.id), ['older']);
});

test('show_chart validates its input and returns only shown; its label names the title', () => {
  const { deps } = setup();
  const points = [{ label: 'Food', value: 4000 }, { label: 'Rent', value: 150000 }, { label: 'Fun', value: 2500 }];
  const chart = { kind: 'bar', title: 'March spending by category', unit: 'usd_cents', points };
  assert.deepEqual(runTool(deps, 'show_chart', chart), { content: '{"shown":true}', isError: false });
  assert.equal(runTool(deps, 'show_chart', { ...chart, kind: 'line', unit: 'percent', points: points.slice(0, 2) }).isError, false);
  assert.equal(runTool(deps, 'show_chart', { ...chart, unit: 'percent', points: [{ label: 'A', value: 12.5 }, { label: 'B', value: 7.25 }] }).isError, false);
  for (const bad of [{ ...chart, kind: 'pie' }, { ...chart, unit: 'eur' }, { ...chart, title: 'x'.repeat(61) }, { ...chart, title: '' },
    { ...chart, points: points.slice(0, 1) }, { ...chart, points: Array.from({ length: 32 }, (_, i) => ({ label: `d${i}`, value: i })) },
    { ...chart, points: [{ label: 'x'.repeat(25), value: 1 }, ...points] }, { ...chart, points: [{ label: 'Food', value: '4000' }, ...points] }, { ...chart, extra: 1 }, { ...chart, points: [{ label: 'Food', value: 40.5 }, ...points] }]) {
    assert.equal(runTool(deps, 'show_chart', bad).isError, true, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(toolLabel('show_chart', chart), 'Chart · March spending by category');
});

test('open_items matches the person screen and lists only people with something open', () => {
  const { deps, db } = setup();
  seedPerson(db, { id: 'p2', name: 'Synthetic Wren' });
  seedTxn(db, { id: 'owed', accountId: 'a1', date: '2026-03-06', amountCents: -2000, personId: 'p1', payee: 'SYNTHETIC CONCERT' });
  seedTxn(db, { id: 'lent', accountId: 'a1', date: '2026-03-06', amountCents: -1000, personId: 'p2' });
  seedTxn(db, { id: 'repaid', accountId: 'a1', date: '2026-03-07', amountCents: 1000, personId: 'p2' });
  assert.deepEqual(call(deps, 'open_items', {}), [{ personId: 'p1', name: 'Synthetic Quill', items: getPerson(db, 'p1')!.openItems }]);
  seedPerson(db, { id: 'p3', name: 'Synthetic Moss', archived: true });
  seedTxn(db, { id: 'old', accountId: 'a1', date: '2026-03-04', amountCents: -700, personId: 'p3', payee: 'SYNTHETIC LUNCH' });
  assert.deepEqual(call(deps, 'open_items', { personId: 'p1' }), [{ personId: 'p1', name: 'Synthetic Quill', items: getPerson(db, 'p1')!.openItems }]);
  assert.deepEqual(call(deps, 'open_items', {}).map((p: { personId: string }) => p.personId), ['p1', 'p3']);
  assert.deepEqual(call(deps, 'open_items', { personId: 'p2' }), []);
  assert.equal(toolLabel('open_items', {}), 'Open IOUs');
});

test('profile tools match the profile functions and never write', () => {
  const { deps, db, today } = setup();
  db.prepare("INSERT INTO jobs (id, employer, status, created_at, updated_at) VALUES ('j1', 'SYNTHETIC EMPLOYER', 'current', 'x', 'x')").run();
  const stub = db.prepare(`INSERT INTO pay_stubs (id, job_id, pay_date, gross_cents, federal_cents, state_cents, social_security_cents, medicare_cents,
    retirement_cents, other_deductions_cents, net_cents, created_at) VALUES (?, ?, ?, 100, 10, 5, 6, 2, 5, 2, 70, 'x')`);
  stub.run('s1', 'j1', '2025-12-30'); stub.run('s2', 'j1', '2026-01-15'); stub.run('s3', 'j1', '2026-02-15'); stub.run('s4', null, '2026-02-15');
  const tables = ['profile', 'jobs', 'pay_stubs', 'tax_forms', 'tax_returns', 'equity_grants'];
  const counts = () => tables.map((t) => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get());
  const before = counts();
  assert.deepEqual(call(deps, 'profile', {}, UNLOCKED), getProfile(db));
  assert.deepEqual(call(deps, 'jobs', {}, UNLOCKED), listJobs(db));
  assert.deepEqual(call(deps, 'jobs', { id: 'j1' }, UNLOCKED), JSON.parse(JSON.stringify(getJob(db, 'j1', today))));
  assert.equal(runTool(deps, 'jobs', { id: 'nope' }, UNLOCKED).isError, true);
  assert.deepEqual(call(deps, 'tax_years', {}, UNLOCKED), taxYears(db));
  const all = call(deps, 'pay_stubs', {}, UNLOCKED);
  assert.deepEqual(all.stubs.map((s: { id: string }) => s.id), ['s3', 's4', 's2', 's1']);
  assert.deepEqual(all.ytd, [
    { jobId: 'j1', year: 2025, grossCents: 100, federalCents: 10, stateCents: 5, socialSecurityCents: 6, medicareCents: 2, retirementCents: 5, otherDeductionsCents: 2, otherPayCents: 0, netCents: 70 },
    { jobId: null, year: 2026, grossCents: 100, federalCents: 10, stateCents: 5, socialSecurityCents: 6, medicareCents: 2, retirementCents: 5, otherDeductionsCents: 2, otherPayCents: 0, netCents: 70 },
    { jobId: 'j1', year: 2026, grossCents: 200, federalCents: 20, stateCents: 10, socialSecurityCents: 12, medicareCents: 4, retirementCents: 10, otherDeductionsCents: 4, otherPayCents: 0, netCents: 140 },
  ]);
  const ranged = call(deps, 'pay_stubs', { from: '2026-01-01', to: '2026-01-31', jobId: 'j1' }, UNLOCKED);
  assert.deepEqual(ranged.stubs.map((s: { id: string }) => s.id), ['s2']);
  const mid = call(deps, 'pay_stubs', { from: '2026-02-01', jobId: 'j1' }, UNLOCKED);
  assert.deepEqual(mid.stubs.map((s: { id: string }) => s.id), ['s3']);
  assert.deepEqual(mid.ytd.map((y: { year: number; grossCents: number; netCents: number }) => [y.year, y.grossCents, y.netCents]), [[2026, 200, 140]]);
  assert.deepEqual(call(deps, 'pay_stubs', { from: '2030-01-01' }, UNLOCKED), { stubs: [], ytd: [] });
  assert.equal(runTool(deps, 'pay_stubs', { from: 'bad' }, UNLOCKED).isError, true);
  assert.deepEqual(counts(), before);
});

test('profile tools refuse unless the question was asked with the profile unlocked', () => {
  const { deps } = setup();
  for (const name of ['profile', 'jobs', 'pay_stubs', 'tax_years', 'tax_projection', 'tax_what_if', 'investment_activity', 'tax_lots']) {
    const input = name === 'tax_what_if' ? { year: 2026, change: {} } : {};
    for (const ctx of [undefined, {}, { profileUnlocked: false }]) {
      const r = runTool(deps, name, input, ctx);
      assert.equal(r.isError, true, name);
      assert.match(r.content, /financial profile is locked/);
    }
    assert.equal(runTool(deps, name, input, UNLOCKED).isError, false, name);
  }
  assert.equal(runTool(deps, 'categories', {}).isError, false, 'other tools need no unlock');
});

test('profile tool labels', () => {
  assert.equal(toolLabel('profile', {}), 'About me');
  assert.equal(toolLabel('jobs', {}), 'Jobs');
  assert.equal(toolLabel('pay_stubs', { from: '2026-01-01' }), 'Pay stubs · Since 2026-01-01');
  assert.equal(toolLabel('tax_years', {}), 'Tax years');
});

test('tax_reference gives a year\'s federal figures in cents, the server file\'s state figures, and says which years it has for one it lacks', () => {
  const { deps } = makeTestDeps();
  const fed = JSON.parse(runTool(deps, 'tax_reference', { year: 2026 }).content) as { federal: { standardDeduction: { single: number }; ira: { limit: number } }; states?: unknown };
  assert.deepEqual([fed.federal.standardDeduction.single, fed.federal.ira.limit, fed.states], [1_610_000, 750_000, undefined]);
  const file = join(mkdtempSync(join(tmpdir(), 'hermes-tax-')), 'states.json');
  const XA = { model: 'flat', rate: 0.05, exemptionCents: 0, dependentExemptionCents: 0, source: 'synthetic' };
  // a malformed entry is left out, as the calculator leaves it out
  writeFileSync(file, JSON.stringify({ 2026: { XA, ZZ: { rate: 0.05, source: 'synthetic' } } }));
  deps.config.stateTaxFile = file;
  assert.deepEqual((JSON.parse(runTool(deps, 'tax_reference', { year: 2026 }).content) as { states: unknown }).states, { XA });
  writeFileSync(file, 'not json');
  assert.equal((JSON.parse(runTool(deps, 'tax_reference', { year: 2026 }).content) as { states?: unknown }).states, undefined, 'a broken file leaves the federal figures');
  assert.deepEqual(JSON.parse(runTool(deps, 'tax_reference', { year: 2031 }).content), { year: 2031, available: [2026, 2027], note: 'no 2031 figures in Hermes yet' });
  assert.equal(toolLabel('tax_reference', { year: 2026 }), 'Tax figures');
});

test('tax tools match the tax functions; investment_activity gives cash in/out with ticker and account, and sales', () => {
  const { deps, db, today } = setup();
  seedAccount(db, { id: 'br', type: 'investment', subtype: 'brokerage' });
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('s1', 'Synthetic Fund', 'SYN', 'etf', 0, 'x')").run();
  const ins = db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, 'br', 's1', ?, ?, ?, ?, ?, 'x')");
  ins.run('i1', '2026-01-05', 'buy', 'buy', 10, 100_000);
  ins.run('i2', '2026-02-05', 'sell', 'sell', -4, -50_000);
  assert.deepEqual(call(deps, 'tax_projection', { year: 2026 }, UNLOCKED), JSON.parse(JSON.stringify(project(deps, 2026, today))));
  assert.deepEqual(call(deps, 'tax_what_if', { year: 2026, change: { extraWithholdingCents: 1000 } }, UNLOCKED),
    JSON.parse(JSON.stringify(whatIf(deps, 2026, today, { extraWithholdingCents: 1000 }))));
  assert.equal(runTool(deps, 'tax_what_if', { year: 2026, change: { bogus: 1 } }, UNLOCKED).isError, true);
  const view = lotsView(buildLots(db, today));
  assert.deepEqual(call(deps, 'tax_lots', { accountId: 'br' }, UNLOCKED), JSON.parse(JSON.stringify({
    lots: view.lots.filter((l) => l.accountId === 'br'), methods: { br: view.methods.br }, inferred: { br: view.inferred.br }, basisMatched: { br: view.basisMatched.br }, unresolved: [],
  })));
  // pre-history shares sold: unresolved, for that account only
  ins.run('i3', '2026-02-06', 'sell', 'sell', -8, -80_000);
  assert.deepEqual((call(deps, 'tax_lots', { accountId: 'br' }, UNLOCKED) as { unresolved: unknown[] }).unresolved, [{ accountId: 'br', securityId: 's1', ticker: 'SYN', quantity: 2 }]);
  assert.deepEqual((call(deps, 'tax_lots', { accountId: 'other' }, UNLOCKED) as { unresolved: unknown[]; methods: object }), { lots: [], methods: {}, inferred: {}, basisMatched: {}, unresolved: [] });
  db.prepare("DELETE FROM investment_transactions WHERE id = 'i3'").run();
  const all = call(deps, 'investment_activity', {}, UNLOCKED) as { transactions: { id: string; ticker: string; account: string; cashCents: number }[]; sales: { ticker: string; account: string }[] };
  assert.deepEqual(all.transactions.map((t) => [t.id, t.ticker, t.cashCents]), [['i2', 'SYN', 50_000], ['i1', 'SYN', -100_000]]);
  assert.equal(typeof all.transactions[0]!.account, 'string');
  assert.equal(all.sales.length, 1);
  assert.deepEqual([all.sales[0]!.ticker, typeof all.sales[0]!.account], ['SYN', 'string']);
  const feb = call(deps, 'investment_activity', { from: '2026-02-01', type: 'sell' }, UNLOCKED) as { transactions: unknown[] };
  assert.equal(feb.transactions.length, 1);
  assert.equal((call(deps, 'investment_activity', { to: '2026-01-31' }, UNLOCKED) as { sales: unknown[] }).sales.length, 0);
});

test('a large investment_activity result is trimmed to valid JSON under the cap', () => {
  const { deps, db } = setup();
  seedAccount(db, { id: 'br', type: 'investment' });
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('s1', 'Synthetic Fund', 'SYN', 'etf', 0, 'x')").run();
  const ins = db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, 'br', 's1', '2026-01-05', 'buy', 'buy', 1, 100, 'x')");
  const sell = db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, 'br', 's1', ?, 'sell', 'sell', -1, -100, 'x')");
  for (let i = 0; i < 300; i++) { ins.run(`b${i}`); sell.run(`s${i}`, `2026-02-${String(1 + (i % 25)).padStart(2, '0')}`); }
  const r = runTool(deps, 'investment_activity', {}, UNLOCKED);
  assert.ok(r.content.length <= RESULT_MAX);
  const out = JSON.parse(r.content) as { truncated: boolean; transactions: unknown[]; sales: unknown[] };
  assert.equal(out.truncated, true);
  assert.ok(Array.isArray(out.transactions) && out.transactions.length < 600);
  assert.ok(Array.isArray(out.sales) && out.sales.length < 300);
  const lots = JSON.parse(runTool(deps, 'tax_lots', {}, UNLOCKED).content) as { lots: unknown[] };
  assert.ok(Array.isArray(lots.lots));
});

test('a large tax_lots result is trimmed to valid JSON under the cap, lots and all', () => {
  const { deps, db } = setup();
  seedAccount(db, { id: 'br', type: 'investment' });
  db.prepare("INSERT INTO securities (id, name, ticker, type, is_cash, updated_at) VALUES ('s1', 'Synthetic Fund', 'SYN', 'etf', 0, 'x')").run();
  const ins = db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, 'br', 's1', ?, 'buy', 'buy', 1, 100, 'x')");
  for (let i = 0; i < 1500; i++) ins.run(`b${i}`, `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`);
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, price_cents, value_cents, cost_basis_cents, updated_at) VALUES ('br', 's1', 1500, 100, 150000, 150000, 'x')").run();
  const r = runTool(deps, 'tax_lots', {}, UNLOCKED);
  assert.ok(r.content.length <= RESULT_MAX);
  const out = JSON.parse(r.content) as { truncated: boolean; lots: unknown[] };
  assert.equal(out.truncated, true);
  assert.ok(Array.isArray(out.lots) && out.lots.length > 0 && out.lots.length < 1500);
});

test('tax tool labels and descriptions', () => {
  assert.deepEqual(['tax_projection', 'tax_what_if', 'investment_activity', 'tax_lots'].map((n) => toolLabel(n, {})), ['Tax projection', 'What if', 'Investment activity', 'Tax lots']);
  const d = TOOLS.find((t) => t.name === 'investments')!.description;
  assert.doesNotMatch(d, /no trades/);
  assert.match(d, /investment_activity/);
});

test('tax_projection without a year uses the first open year', () => {
  const { deps } = setup();
  deps.now = () => new Date('2026-02-10T12:00:00Z');
  assert.equal(call(deps, 'tax_projection', {}, UNLOCKED).year, 2025);
  deps.now = () => new Date('2026-06-10T12:00:00Z');
  assert.equal(call(deps, 'tax_projection', {}, UNLOCKED).year, 2026);
});

function withDocument() {
  const s = setup();
  const { db } = s;
  db.prepare("INSERT INTO jobs (id, employer, status, created_at, updated_at) VALUES ('j1', 'SYNTHETIC EMPLOYER', 'current', 'x', 'x')").run();
  db.prepare(`INSERT INTO pay_stubs (id, job_id, pay_date, gross_cents, federal_cents, state_cents, social_security_cents, medicare_cents,
    retirement_cents, other_deductions_cents, net_cents, created_at) VALUES ('s1', 'j1', '2026-03-15', 100, 10, 5, 6, 2, 5, 2, 70, 'x')`).run();
  db.prepare("INSERT INTO state_w4s (job_id, state, updated_at) VALUES ('j1', 'XA', 'x')").run();
  const pages = [1, 2, 3, 4, 5].map((n) => Buffer.from([0xff, 0xd8, n]));
  const stubDoc = saveDocument(db, 'pay_stub', pages, new Date('2026-03-16T12:00:00Z'));
  linkDocument(db, stubDoc, 'pay_stub', 's1');
  const formDoc = saveDocument(db, 'state_w4', pages.slice(0, 1), new Date('2026-03-17T12:00:00Z'));
  linkDocument(db, formDoc, 'state_w4', 'j1:XA');
  return { ...s, stubDoc, formDoc, pages };
}

test('documents lists kept documents with a short description of each linked record, filtered by record or kind', () => {
  const { deps, stubDoc, formDoc } = withDocument();
  const all = call(deps, 'documents', {}, UNLOCKED);
  assert.deepEqual(all.documents.map((d: { id: string }) => d.id), [formDoc, stubDoc]);
  assert.deepEqual(all.documents[1].links, [{ recordType: 'pay_stub', recordId: 's1', description: 'Pay stub 2026-03-15, SYNTHETIC EMPLOYER' }]);
  assert.deepEqual(all.documents[0].links, [{ recordType: 'state_w4', recordId: 'j1:XA', description: 'State W-4 XA, SYNTHETIC EMPLOYER' }]);
  assert.deepEqual(call(deps, 'documents', { recordType: 'pay_stub', recordId: 's1' }, UNLOCKED).documents.map((d: { id: string }) => d.id), [stubDoc]);
  assert.deepEqual(call(deps, 'documents', { kind: 'state_w4' }, UNLOCKED).documents.map((d: { id: string }) => d.id), [formDoc]);
  assert.equal(runTool(deps, 'documents', { recordType: 'pay_stub' }, UNLOCKED).isError, true);
  assert.deepEqual([toolLabel('documents', {}), toolLabel('document_pages', { id: stubDoc })], ['Documents', 'Document pages']);
});

test('document_pages returns JPEG image blocks and a stored form with placeholders; at most 4 pages', () => {
  const { deps, stubDoc, pages } = withDocument();
  const r = runTool(deps, 'document_pages', { id: stubDoc, pages: [2, 5] }, UNLOCKED);
  assert.equal(r.isError, false);
  assert.equal(r.profile, true);
  assert.match(r.content, new RegExp(`${stubDoc}.*pages 2, 5 of 5`));
  assert.deepEqual(r.images!.map((i) => i.block), [2, 5].map((n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pages[n - 1]!.toString('base64') } })));
  assert.deepEqual(r.images!.map((i) => i.stored), [2, 5].map((n) => ({ type: 'text', text: `[document pages shown earlier: ${stubDoc} p.${n}]` })));
  assert.equal(runTool(deps, 'document_pages', { id: stubDoc }, UNLOCKED).images!.length, 4, 'no pages: the first 4');
  const five = runTool(deps, 'document_pages', { id: stubDoc, pages: [1, 2, 3, 4, 5] }, UNLOCKED);
  assert.deepEqual([five.isError, five.images], [true, undefined]);
  const missing = runTool(deps, 'document_pages', { id: stubDoc, pages: [6] }, UNLOCKED);
  assert.deepEqual([missing.isError, /6/.test(missing.content)], [true, true]);
  assert.equal(runTool(deps, 'document_pages', { id: 'nope' }, UNLOCKED).isError, true);
});

test('document tools refuse while the profile is locked', () => {
  const { deps, stubDoc } = withDocument();
  for (const [name, input] of [['documents', {}], ['document_pages', { id: stubDoc }]] as const) {
    const r = runTool(deps, name, input);
    assert.deepEqual([r.isError, /financial profile is locked/.test(r.content), r.images], [true, true, undefined]);
  }
});
