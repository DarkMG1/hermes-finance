import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { AUTH, makeTestDeps, seedAccount } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  let n = 0;
  const get = async (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  return { get, send, db: deps.db };
}

test('inputs replace whole and replay one key', async () => {
  const { get, send, db } = setup();
  assert.deepEqual((await get('/v1/tax/inputs/2026')).json(), { year: 2026, tuitionCents: null, scholarshipsCents: null, studentLoanInterestCents: null, k401Cents: null, updatedAt: null });
  const first = await send('PUT', '/v1/tax/inputs/2026', { tuitionCents: 500000, k401Cents: 100000 }, 'same');
  assert.deepEqual([first.statusCode, first.json().tuitionCents, first.json().k401Cents, first.json().scholarshipsCents], [200, 500000, 100000, null]);
  const replay = await send('PUT', '/v1/tax/inputs/2026', { tuitionCents: 500000, k401Cents: 100000 }, 'same');
  assert.deepEqual(replay.json(), first.json());
  const replaced = await send('PUT', '/v1/tax/inputs/2026', { scholarshipsCents: 7000 });
  assert.deepEqual([replaced.json().tuitionCents, replaced.json().k401Cents, replaced.json().scholarshipsCents], [null, null, 7000]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM tax_inputs').pluck().get(), 1);
  assert.equal((await send('PUT', '/v1/tax/inputs/2026', { tuitionCents: -1 })).statusCode, 400);
  assert.equal((await send('PUT', '/v1/tax/inputs/2026', { bogus: 1 })).statusCode, 400);
});

test('scenario moveTo must be a 2-letter code and moveDate within the year', async () => {
  const { get, send } = setup();
  assert.equal((await get('/v1/tax/scenario/2027')).json().moveTo, null);
  const bad = await send('PUT', '/v1/tax/scenario/2027', { moveTo: 'XAX' });
  assert.deepEqual([bad.statusCode, bad.json().field], [400, 'moveTo']);
  const lower = await send('PUT', '/v1/tax/scenario/2027', { moveTo: 'xa' });
  assert.equal(lower.statusCode, 400);
  const outside = await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2026-12-31', moveTo: 'XA' });
  assert.deepEqual([outside.statusCode, outside.json().field], [400, 'moveDate']);
  const ok = await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2027-06-01', moveTo: 'XA', relocationCents: 300000, bonusCents: 1000000 });
  assert.deepEqual([ok.statusCode, ok.json().moveDate, ok.json().moveTo, ok.json().relocationCents, ok.json().k401Cents], [200, '2027-06-01', 'XA', 300000, null]);
  const cleared = await send('PUT', '/v1/tax/scenario/2027', {});
  assert.deepEqual([cleared.json().moveDate, cleared.json().bonusCents], [null, null]);
});

test('roth contribution taxYear may be the deposit year or the year before only when dated Jan 1-Apr 15', async () => {
  const { get, send } = setup();
  const post = (date: string, taxYear: number) => send('POST', '/v1/tax/roth-contributions', { date, amountCents: 100000, taxYear });
  assert.equal((await post('2026-03-01', 2026)).statusCode, 201);
  assert.equal((await post('2026-04-15', 2025)).statusCode, 201);
  for (const [date, year] of [['2026-04-16', 2025], ['2026-06-01', 2025], ['2026-03-01', 2027], ['2026-03-01', 2024]] as const) {
    const r = await post(date, year);
    assert.deepEqual([r.statusCode, r.json().field], [400, 'taxYear'], `${date} ${year}`);
  }
  const mid = (await post('2026-07-04', 2026)).json();
  assert.equal((await send('PUT', `/v1/tax/roth-contributions/${mid.id}`, { taxYear: 2025 })).json().field, 'taxYear');
  const early = (await post('2026-02-01', 2026)).json();
  assert.equal((await send('PUT', `/v1/tax/roth-contributions/${early.id}`, { taxYear: 2025 })).json().taxYear, 2025);
  assert.equal((await send('PUT', '/v1/tax/roth-contributions/nope', { taxYear: 2025 })).statusCode, 404);
  assert.equal((await get('/v1/tax/roth-contributions?taxYear=2025')).json().contributions.length, 2);
  assert.equal((await send('DELETE', `/v1/tax/roth-contributions/${early.id}`)).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/tax/roth-contributions/${early.id}`)).statusCode, 404);
  assert.equal((await get('/v1/tax/roth-contributions')).statusCode, 400);
});

test('roth deposits into a roth account are suggested once', async () => {
  const { get, send, db } = setup();
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  seedAccount(db, { id: 'brk', type: 'investment', subtype: 'brokerage' });
  const ins = db.prepare('INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)');
  ins.run('d1', 'roth', '2026-02-10', 'cash', 'deposit', -600000, 'x');
  ins.run('t1', 'roth', '2026-05-10', 'transfer', 'transfer', -50000, 'x');
  ins.run('w1', 'roth', '2026-05-11', 'cash', 'withdrawal', 20000, 'x');
  ins.run('b1', 'brk', '2026-02-10', 'cash', 'deposit', -999, 'x');
  const list = async (y: number) => (await get(`/v1/tax/roth-contributions?taxYear=${y}`)).json().contributions as { id: string; amountCents: number; taxYear: number; transactionId: string }[];
  const a = await list(2026);
  assert.deepEqual(a.map((c) => [c.transactionId, c.amountCents, c.taxYear]), [['d1', 600000, 2026], ['t1', 50000, 2026]]);
  assert.deepEqual(await list(2026), a);
  assert.equal(db.prepare('SELECT COUNT(*) FROM roth_contributions').pluck().get(), 2);
  // moving one to the prior year sticks across lists; deleting one does not bring it back
  assert.equal((await send('PUT', `/v1/tax/roth-contributions/${a[0]!.id}`, { taxYear: 2025 })).json().taxYear, 2025);
  assert.deepEqual((await list(2025)).map((c) => c.transactionId), ['d1']);
  assert.equal((await send('DELETE', `/v1/tax/roth-contributions/${a[1]!.id}`)).statusCode, 200);
  assert.deepEqual(await list(2026), []);
});

test('roth suggestions follow their source: amount and date refresh, a removed source stops counting, the owner\'s year and dismissals stay', async () => {
  const { get, send, db } = setup();
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  seedAccount(db, { id: 'roth2', type: 'investment', subtype: 'roth' });
  const ins = db.prepare('INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)');
  ins.run('d1', 'roth', '2026-02-10', 'cash', 'deposit', -100000, 'x');
  ins.run('d2', 'roth', '2026-03-01', 'cash', 'deposit', -200000, 'x');
  ins.run('d3', 'roth', '2026-03-05', 'cash', 'deposit', -300000, 'x');
  // a move between two Roth accounts is no contribution
  ins.run('o1', 'roth2', '2026-03-02', 'transfer', 'transfer', 400000, 'x');
  ins.run('i1', 'roth', '2026-03-04', 'transfer', 'transfer', -400000, 'x');
  const list = async (y: number) => (await get(`/v1/tax/roth-contributions?taxYear=${y}`)).json().contributions as { id: string; date: string; amountCents: number; transactionId: string }[];
  const a = await list(2026);
  assert.deepEqual(a.map((c) => c.transactionId), ['d1', 'd2', 'd3']);
  assert.equal((await send('PUT', `/v1/tax/roth-contributions/${a[0]!.id}`, { taxYear: 2025 })).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/tax/roth-contributions/${a[2]!.id}`)).statusCode, 200);
  // a sync corrects d1's amount (still Jan–Apr 15: the owner's 2025 stays) and d3's; drops d2
  db.prepare("UPDATE investment_transactions SET amount_cents = -700000, date = '2026-02-11' WHERE id = 'd1'").run();
  db.prepare("UPDATE investment_transactions SET amount_cents = -350000 WHERE id = 'd3'").run();
  db.prepare("DELETE FROM investment_transactions WHERE id = 'd2'").run();
  assert.deepEqual((await list(2025)).map((c) => [c.transactionId, c.date, c.amountCents]), [['d1', '2026-02-11', 700000]]);
  assert.deepEqual(await list(2026), []);
  // a date moved past Apr 15 can't stay in the prior year
  db.prepare("UPDATE investment_transactions SET date = '2026-05-01' WHERE id = 'd1'").run();
  assert.deepEqual((await list(2026)).map((c) => c.transactionId), ['d1']);
});

test('an owner-edited roth suggestion keeps its amount and date on refresh; an untouched one follows its source', async () => {
  const { get, send, db } = setup();
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  const ins = db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES (?, 'roth', NULL, ?, 'cash', 'deposit', 0, ?, 'x')");
  ins.run('d1', '2026-02-10', -100000);
  ins.run('d2', '2026-02-12', -200000);
  const list = async () => ((await get('/v1/tax/roth-contributions?taxYear=2026')).json().contributions as { id: string; date: string; amountCents: number; transactionId: string }[])
    .map((c) => [c.transactionId, c.date, c.amountCents]);
  await list();
  const edited = await send('PUT', '/v1/tax/roth-contributions/roth-d1', { amountCents: 90000, date: '2026-02-09' });
  assert.deepEqual([edited.statusCode, edited.json().amountCents, edited.json().date, edited.json().taxYear], [200, 90000, '2026-02-09', 2026]);
  db.prepare("UPDATE investment_transactions SET amount_cents = amount_cents - 5000, date = '2026-02-14'").run();
  assert.deepEqual(await list(), [['d1', '2026-02-09', 90000], ['d2', '2026-02-14', 205000]]);
  // a date the stored tax year doesn't allow is refused; an empty edit too
  assert.equal((await send('PUT', '/v1/tax/roth-contributions/roth-d1', { date: '2025-12-01' })).json().field, 'taxYear');
  assert.equal((await send('PUT', '/v1/tax/roth-contributions/roth-d1', {})).statusCode, 400);
});

test('roth contributions: a year out of range is 400; a dismissed suggestion is 404 to PUT and DELETE', async () => {
  const { get, send, db } = setup();
  for (const y of ['1999', '2028', 'x']) assert.equal((await get(`/v1/tax/roth-contributions?taxYear=${y}`)).statusCode, 400, y);
  assert.equal((await get('/v1/tax/roth-contributions?taxYear=2027')).statusCode, 200);
  seedAccount(db, { id: 'roth', type: 'investment', subtype: 'roth' });
  db.prepare("INSERT INTO investment_transactions (id, account_id, security_id, date, type, subtype, quantity, amount_cents, updated_at) VALUES ('d1', 'roth', NULL, '2026-02-10', 'cash', 'deposit', 0, -100000, 'x')").run();
  const [c] = (await get('/v1/tax/roth-contributions?taxYear=2026')).json().contributions;
  assert.equal((await send('DELETE', `/v1/tax/roth-contributions/${c.id}`)).statusCode, 200);
  assert.equal((await send('PUT', `/v1/tax/roth-contributions/${c.id}`, { taxYear: 2025 })).statusCode, 404);
  assert.equal((await send('DELETE', `/v1/tax/roth-contributions/${c.id}`)).statusCode, 404);
});

test('scenario moveDate edges: the first and last day of the year; year bounds', async () => {
  const { send } = setup();
  for (const d of ['2027-01-01', '2027-12-31']) assert.equal((await send('PUT', '/v1/tax/scenario/2027', { moveDate: d, moveTo: 'XA' })).statusCode, 200, d);
  assert.equal((await send('PUT', '/v1/tax/scenario/2000', { moveDate: '2000-01-01', moveTo: 'XA' })).statusCode, 200);
  assert.equal((await send('PUT', '/v1/tax/scenario/2027', { moveDate: '2028-01-01', moveTo: 'XA' })).statusCode, 400);
  for (const y of ['1999', '2028']) assert.equal((await send('PUT', `/v1/tax/scenario/${y}`, {})).statusCode, 400, y);
});
