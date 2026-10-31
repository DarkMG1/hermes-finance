import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_MAX, TOOLS, runTool } from '../src/chat/tools.ts';
import { toolLabel } from '../src/chat/labels.ts';
import { getExpenses, getSpending } from '../src/cashflow.ts';
import { getNetWorth, localDay } from '../src/networth.ts';
import { getInvestments } from '../src/investments.ts';
import { getRecurring } from '../src/recurring.ts';
import { listAccounts, listTransactions } from '../src/ledger.ts';
import { listPeople } from '../src/people.ts';
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
const call = (deps: ReturnType<typeof setup>['deps'], name: string, input: unknown) => JSON.parse(runTool(deps, name, input).content);

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
