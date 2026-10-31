import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_MAX, TOOLS, runTool, toolLabel } from '../src/chat/tools.ts';
import { getSpending } from '../src/cashflow.ts';
import { getNetWorth, localDay } from '../src/networth.ts';
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
  assert.deepEqual(call(deps, 'people', {}), listPeople(db, false));
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
  assert.equal(toolLabel('spending', { period: 'month', date: '2026-09' }), 'Spending · 2026-09');
  assert.equal(toolLabel('accounts', {}), 'Accounts');
});
