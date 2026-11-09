import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { migrate, openDb } from '../src/db.ts';
import { vestEvents } from '../src/profile.ts';
import { applyPages } from '../src/sync/apply.ts';
import type { SyncPage } from '../src/plaid/port.ts';
import { txn } from './fake-plaid.ts';
import { AUTH, makeTestDeps, seedAccount, seedTxn } from './helpers.ts';

function setup() {
  const { deps } = makeTestDeps();
  const app = buildApp(deps);
  let n = 0;
  const get = async (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  return { get, send, db: deps.db };
}

const count = (db: ReturnType<typeof setup>['db'], table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

test('About me starts empty, saves the fields given, keeps the rest, and replays one Idempotency-Key', async () => {
  const { get, send } = setup();
  assert.deepEqual((await get('/v1/profile')).json(), {
    state: null, filingStatus: null, birthYear: null, dependents: null, retirementPct: null, retirementKind: null, hsa: null, note: null, updatedAt: null,
  });
  const put = await send('PUT', '/v1/profile', { state: 'CA', filingStatus: 'single', birthYear: 1980, dependents: 0, retirementPct: 6, retirementKind: 'roth', hsa: true }, 'same');
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), (await send('PUT', '/v1/profile', { state: 'CA', filingStatus: 'single', birthYear: 1980, dependents: 0, retirementPct: 6, retirementKind: 'roth', hsa: true }, 'same')).json());
  const p = (await send('PUT', '/v1/profile', { note: 'Synthetic note', hsa: null })).json();
  assert.deepEqual([p.state, p.retirementPct, p.hsa, p.note, p.updatedAt], ['CA', 6, null, 'Synthetic note', '2026-03-15T12:00:00.000Z']);
  assert.deepEqual((await get('/v1/profile')).json(), p);
});

test('About me rejects bad values with the field', async () => {
  const { send } = setup();
  for (const [body, field] of [
    [{ filingStatus: 'joint' }, 'filingStatus'], [{ birthYear: 1899 }, 'birthYear'], [{ birthYear: 2027 }, 'birthYear'],
    [{ dependents: 21 }, 'dependents'], [{ dependents: -1 }, 'dependents'], [{ retirementPct: 100.5 }, 'retirementPct'],
    [{ note: 'x'.repeat(2001) }, 'note'], [{ state: 'zz' }, 'state'], [{ ssn: '000-00-0000' }, undefined],
  ] as const) {
    const r = await send('PUT', '/v1/profile', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().field, field);
  }
  assert.equal((await send('PUT', '/v1/profile', { birthYear: 2026, retirementPct: 100, dependents: 20 })).statusCode, 200);
});

test('jobs: create, list, patch, validate status and dates, delete', async () => {
  const { get, send } = setup();
  const made = await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', baseCents: 12_000_000, startDate: '2026-06-01' }, 'job');
  assert.equal(made.statusCode, 201);
  const job = made.json();
  assert.deepEqual([job.employer, job.title, job.status, job.baseCents, job.endDate, job.createdAt], ['SYNTHETIC EMPLOYER', null, 'offered', 12_000_000, null, '2026-03-15T12:00:00.000Z']);
  assert.deepEqual((await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', baseCents: 12_000_000, startDate: '2026-06-01' }, 'job')).json(), job);
  assert.deepEqual((await get('/v1/jobs')).json().map((j: { id: string }) => j.id), [job.id]);
  assert.equal((await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'hired' })).json().field, 'status');
  const hourly = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current', hourlyCents: 3750, hoursPerWeek: 20 }, 'hourly')).json();
  assert.deepEqual([hourly.baseCents, hourly.hourlyCents, hourly.hoursPerWeek], [null, 3750, 20]);
  assert.equal((await send('POST', '/v1/jobs', { employer: 'X', status: 'current', hoursPerWeek: 0 })).json().field, 'hoursPerWeek');
  assert.equal((await send('POST', '/v1/jobs', { employer: 'X', status: 'current', hoursPerWeek: 169 })).json().field, 'hoursPerWeek');
  const cleared = (await send('PATCH', `/v1/jobs/${hourly.id}`, { hourlyCents: null })).json();
  assert.deepEqual([cleared.hourlyCents, cleared.hoursPerWeek], [null, 20]);
  assert.equal((await send('DELETE', `/v1/jobs/${hourly.id}`)).statusCode, 200);
  const monthly = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'past', monthlyCents: 500000, hoursPerWeek: 40 }, 'monthly')).json();
  assert.deepEqual([monthly.baseCents, monthly.monthlyCents, monthly.hourlyCents], [null, 500000, null], 'an internship paid by the month');
  assert.equal((await send('PATCH', `/v1/jobs/${monthly.id}`, { monthlyCents: null })).json().monthlyCents, null);
  assert.equal((await send('POST', '/v1/jobs', { employer: 'X', status: 'past', monthlyCents: -1 })).json().field, 'monthlyCents');
  assert.equal((await send('POST', '/v1/jobs', { status: 'current' })).json().field, 'employer');
  assert.equal((await send('POST', '/v1/jobs', { employer: 'X', status: 'past', startDate: '2026-02-01', endDate: '2026-01-31' })).json().field, 'endDate');
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}`, { endDate: '2026-05-31' })).json().field, 'endDate', 'checked against the saved start date');
  assert.equal((await send('POST', '/v1/jobs', { employer: 'X', status: 'offered', startDate: '2206-06-01' })).json().field, 'startDate', 'a typo far in the future');
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}`, { endDate: '2027-03-16' })).json().field, 'endDate', 'at most a year from today');
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}`, { endDate: '2027-03-15' })).statusCode, 200);
  const patched = await send('PATCH', `/v1/jobs/${job.id}`, { status: 'accepted', title: 'Synthetic Engineer', baseCents: null });
  assert.deepEqual([patched.statusCode, patched.json().status, patched.json().title, patched.json().baseCents, patched.json().startDate], [200, 'accepted', 'Synthetic Engineer', null, '2026-06-01']);
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}`, {})).statusCode, 400);
  assert.equal((await send('PATCH', '/v1/jobs/missing', { status: 'past' })).statusCode, 404);
  const detail = (await get(`/v1/jobs/${job.id}`)).json();
  assert.deepEqual([detail.grants, detail.nextVests, detail.stubs, detail.forms], [[], [], [], []]);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}`, undefined, 'del')).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}`, undefined, 'del')).statusCode, 200, 'a retried delete replays');
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}`)).statusCode, 404);
  assert.equal((await get(`/v1/jobs/${job.id}`)).statusCode, 404);
});

test('grants: create under a job, validate, patch, delete; next vests across grants after today', async () => {
  const { get, send } = setup();
  const job = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current' })).json();
  const base = { kind: 'rsu', shares: 400, grantDate: '2025-03-15', vestMonths: 48, vestEveryMonths: 3, cliffMonths: 12 };
  const rsu = await send('POST', `/v1/jobs/${job.id}/grants`, base);
  assert.equal(rsu.statusCode, 201);
  assert.deepEqual(rsu.json(), { ...base, id: rsu.json().id, jobId: job.id, valueCents: null, strikeCents: null });
  assert.equal((await send('POST', '/v1/jobs/missing/grants', base)).statusCode, 404);
  for (const [body, field] of [
    [{ ...base, shares: null }, 'shares'], [{ ...base, kind: 'option' }, 'strikeCents'], [{ ...base, cliffMonths: 49 }, 'cliffMonths'],
    [{ ...base, vestEveryMonths: 0 }, 'vestEveryMonths'], [{ ...base, kind: 'psu' }, 'kind'],
    [{ ...base, strikeCents: 100 }, 'strikeCents'], [{ ...base, grantDate: '1999-12-31' }, 'grantDate'],
  ] as const) assert.equal((await send('POST', `/v1/jobs/${job.id}/grants`, body)).json().field, field, JSON.stringify(body));
  const opt = (await send('POST', `/v1/jobs/${job.id}/grants`, { kind: 'option', shares: 90, strikeCents: 150, grantDate: '2026-02-28', cliffMonths: 0, vestMonths: 3, vestEveryMonths: 1 })).json();
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().nextVests, [
    { date: '2026-03-28', shares: 30, valueCents: null, grantId: opt.id },
    { date: '2026-04-28', shares: 30, valueCents: null, grantId: opt.id },
    { date: '2026-05-28', shares: 30, valueCents: null, grantId: opt.id },
    { date: '2026-06-15', shares: 25, valueCents: null, grantId: rsu.json().id },
  ], "the RSU's cliff vests today (2026-03-15), which is not after today");
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}/grants/${opt.id}`, { strikeCents: null })).json().field, 'strikeCents', 'the merged grant is checked');
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}/grants/${opt.id}`, { kind: 'rsu', strikeCents: 150 })).json().field, 'strikeCents', 'an RSU has no strike');
  const p = await send('PATCH', `/v1/jobs/${job.id}/grants/${opt.id}`, { valueCents: 9000, shares: null, kind: 'rsu' });
  assert.deepEqual([p.statusCode, p.json().shares, p.json().valueCents, p.json().strikeCents], [200, null, 9000, null], 'becoming an RSU clears the strike');
  assert.equal((await send('PATCH', `/v1/jobs/other/grants/${opt.id}`, { vestMonths: 6 })).statusCode, 404);
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}/grants/${rsu.json().id}`, { grantDate: '2206-03-15' })).json().field, 'grantDate');
  const cleared = await send('PATCH', `/v1/jobs/${job.id}/grants/${rsu.json().id}`, { cliffMonths: null });
  assert.deepEqual([cleared.statusCode, cleared.json().cliffMonths], [200, 0], 'a cleared cliff is 0');
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}/grants/${opt.id}`)).statusCode, 200);
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().grants.map((g: { id: string }) => g.id), [rsu.json().id]);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}/grants/${opt.id}`)).statusCode, 404);
});

test('deleting a job deletes its grants and keeps its pay stubs and tax forms without the job', async () => {
  const { send, db } = setup();
  const job = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'past' })).json();
  await send('POST', `/v1/jobs/${job.id}/grants`, { kind: 'rsu', valueCents: 100, grantDate: '2026-01-01', vestMonths: 12, vestEveryMonths: 12 });
  seedAccount(db, { id: 'chk' });
  seedTxn(db, { id: 'pay', accountId: 'chk', date: '2026-01-02', amountCents: 70 });
  db.prepare(`INSERT INTO pay_stubs (id, job_id, pay_date, period_start, period_end, gross_cents, federal_cents, state_cents, social_security_cents,
    medicare_cents, retirement_cents, other_deductions_cents, net_cents, created_at) VALUES ('s1', ?, '2026-01-02', '2025-12-16', '2025-12-31', 100, 10, 5, 6, 2, 5, 2, 70, 'x')`).run(job.id);
  db.prepare("INSERT INTO pay_stub_deposits (stub_id, transaction_id) VALUES ('s1', 'pay')").run();
  db.prepare("INSERT INTO tax_forms (id, job_id, year, kind, payer, amount_cents, created_at) VALUES ('f1', ?, 2025, 'w2', 'SYNTHETIC EMPLOYER', 100, 'x')").run(job.id);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}`)).statusCode, 200);
  assert.equal(count(db, 'equity_grants'), 0);
  assert.equal(db.prepare("SELECT job_id FROM pay_stubs WHERE id = 's1'").pluck().get(), null);
  assert.equal(db.prepare("SELECT stub_id FROM pay_stub_deposits WHERE transaction_id = 'pay'").pluck().get(), 's1');
  assert.equal(db.prepare("SELECT job_id FROM tax_forms WHERE id = 'f1'").pluck().get(), null);
});

test('W-4: one per job, replaced whole on save, shown on the job, deleted with it', async () => {
  const { get, send, db } = setup();
  const job = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current' })).json();
  assert.equal((await get(`/v1/jobs/${job.id}`)).json().w4, null);
  const w4 = { signedOn: '2026-01-05', filingStatus: 'single', multipleJobs: true, dependentsCents: 0, otherIncomeCents: 120000, deductionsCents: null,
    extraWithholdingCents: 2500, exempt: false };
  const put = await send('PUT', `/v1/jobs/${job.id}/w4`, w4, 'w4');
  assert.deepEqual([put.statusCode, put.json()], [200, { ...w4, jobId: job.id, updatedAt: '2026-03-15T12:00:00.000Z' }]);
  assert.deepEqual((await send('PUT', `/v1/jobs/${job.id}/w4`, w4, 'w4')).json(), put.json(), 'one write per Idempotency-Key');
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().w4, put.json());
  const newer = (await send('PUT', `/v1/jobs/${job.id}/w4`, { filingStatus: 'married_joint' })).json();
  assert.deepEqual([newer.filingStatus, newer.multipleJobs, newer.extraWithholdingCents, newer.signedOn], ['married_joint', null, null, null], 'a new W-4 replaces the old one');
  assert.equal(count(db, 'w4s'), 1);
  for (const [body, field] of [[{ filingStatus: 'married_separate' }, 'filingStatus'], [{ extraWithholdingCents: -1 }, 'extraWithholdingCents'],
    [{ signedOn: '2206-01-05' }, 'signedOn'], [{ ssn: '000-00-0000' }, undefined]] as const) {
    const r = await send('PUT', `/v1/jobs/${job.id}/w4`, body);
    assert.deepEqual([r.statusCode, r.json().field], [400, field], JSON.stringify(body));
  }
  assert.equal((await send('PUT', '/v1/jobs/missing/w4', {})).statusCode, 404);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}/w4`)).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}/w4`)).statusCode, 404);
  await send('PUT', `/v1/jobs/${job.id}/w4`, w4);
  await send('DELETE', `/v1/jobs/${job.id}`);
  assert.equal(count(db, 'w4s'), 0, "a deleted job's W-4 goes with it");
});

test('state withholding forms: one per job and state, replaced whole, listed by state on the job, deleted with it', async () => {
  const { get, send, db } = setup();
  const job = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current' })).json();
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().stateW4s, []);
  const de4 = { signedOn: '2026-01-05', filingStatus: 'single', allowances: 1, additionalAllowances: 0, extraWithholdingCents: 1000, exempt: false };
  const put = await send('PUT', `/v1/jobs/${job.id}/state-w4/CA`, de4, 'ca');
  assert.deepEqual([put.statusCode, put.json()], [200, { ...de4, state: 'CA', jobId: job.id, updatedAt: '2026-03-15T12:00:00.000Z' }]);
  assert.deepEqual((await send('PUT', `/v1/jobs/${job.id}/state-w4/CA`, de4, 'ca')).json(), put.json(), 'one write per Idempotency-Key');
  await send('PUT', `/v1/jobs/${job.id}/state-w4/NY`, { allowances: 2 });
  assert.equal((await send('PUT', `/v1/jobs/${job.id}/state-w4/OR`, { additionalAllowances: 999 })).json().additionalAllowances, 999, 'a DE-4 often says 999 for no withholding');
  await send('DELETE', `/v1/jobs/${job.id}/state-w4/OR`);
  const replaced = (await send('PUT', `/v1/jobs/${job.id}/state-w4/CA`, { filingStatus: 'married' })).json();
  assert.deepEqual([replaced.filingStatus, replaced.allowances, replaced.exempt], ['married', null, null], 'a new form replaces that state\'s old one');
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().stateW4s.map((w: { state: string; allowances: number | null }) => [w.state, w.allowances]),
    [['CA', null], ['NY', 2]]);
  for (const [url, body, field] of [[`/v1/jobs/${job.id}/state-w4/ca`, {}, 'state'], [`/v1/jobs/${job.id}/state-w4/CA`, { allowances: -1 }, 'allowances'], [`/v1/jobs/${job.id}/state-w4/CA`, { additionalAllowances: 1000 }, 'additionalAllowances'],
    [`/v1/jobs/${job.id}/state-w4/CA`, { filingStatus: 'married_joint' }, 'filingStatus'], [`/v1/jobs/${job.id}/state-w4/CA`, { state: 'NY' }, undefined]] as const) {
    const r = await send('PUT', url, body);
    assert.deepEqual([r.statusCode, r.json().field], [400, field], url + JSON.stringify(body));
  }
  assert.equal((await send('PUT', '/v1/jobs/missing/state-w4/CA', {})).statusCode, 404);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}/state-w4/NY`)).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}/state-w4/NY`)).statusCode, 404);
  await send('DELETE', `/v1/jobs/${job.id}`);
  assert.equal(count(db, 'state_w4s'), 0, "a deleted job's state forms go with it");
});

test('028 keeps AI usage rows, lets the profile reader record, and allows one profile row', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'hermes-m28-')), 'h.db'));
  const m = join(import.meta.dirname, '..', 'migrations');
  db.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of readdirSync(m).filter((x) => /^\d{3}_.+\.sql$/.test(x) && Number(x.slice(0, 3)) <= 27).sort()) {
    db.exec(readFileSync(join(m, f), 'utf8'));
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(Number(f.slice(0, 3)), 'x');
  }
  const ins = db.prepare("INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars) VALUES ('x', '2026-03', 'main', ?, 'm', 1, 1, 0, 0, 7)");
  ins.run('receipt');
  ins.run('chat');
  assert.equal(migrate(db), 32);
  assert.deepEqual(db.prepare('SELECT id, feature, cost_microdollars AS c FROM ai_usage ORDER BY id').all(), [{ id: 1, feature: 'receipt', c: 7 }, { id: 2, feature: 'chat', c: 7 }]);
  ins.run('profile');
  assert.throws(() => ins.run('other'), /CHECK/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ai_usage_month'").get());
  assert.throws(() => db.prepare('INSERT INTO profile (id) VALUES (2)').run(), /CHECK/);
  assert.equal(db.prepare("SELECT id FROM ai_usage WHERE feature = 'profile'").pluck().get(), 3, 'new rows keep counting from the copied ids');
});

test('vesting: 4-year RSU, 12-month cliff, quarterly after', () => {
  const g = { id: 'g1', kind: 'rsu', shares: 400, valueCents: null, strikeCents: null, grantDate: '2026-01-15', cliffMonths: 12, vestMonths: 48, vestEveryMonths: 3 };
  assert.deepEqual(vestEvents(g, '2026-01-15', 3).map((e) => [e.date, e.shares]), [['2027-01-15', 100], ['2027-04-15', 25], ['2027-07-15', 25]]);
  assert.equal(vestEvents(g, '2031-01-01', 4).length, 0, 'fully vested');
});

test('vesting: after the cliff, events count from the cliff, the last at vestMonths', () => {
  const at = (cliffMonths: number, vestEveryMonths: number, vestMonths: number) => vestEvents({ id: 'g', shares: 2400, valueCents: null, grantDate: '2026-01-15',
    cliffMonths, vestMonths, vestEveryMonths }, '2000-01-01', 20).map((e) => e.date.slice(0, 7));
  assert.deepEqual(at(6, 4, 24), ['2026-07', '2026-11', '2027-03', '2027-07', '2027-11', '2028-01']);
  assert.deepEqual(at(5, 3, 12), ['2026-06', '2026-09', '2026-12', '2027-01']);
  assert.deepEqual(at(10, 3, 19), ['2026-11', '2027-02', '2027-05', '2027-08']);
});

test('vesting: an event that vests nothing is left out, and the shares still add up', () => {
  const one = vestEvents({ id: 'g', shares: 1, valueCents: null, grantDate: '2026-01-15', cliffMonths: 0, vestMonths: 48, vestEveryMonths: 1 }, '2000-01-01', 100);
  assert.deepEqual(one.map((e) => [e.date, e.shares]), [['2030-01-15', 1]]);
  const ten = vestEvents({ id: 'g', shares: 10, valueCents: null, grantDate: '2026-01-15', cliffMonths: 0, vestMonths: 48, vestEveryMonths: 1 }, '2000-01-01', 100);
  assert.deepEqual([ten.length, ten.reduce((n, e) => n + e.shares!, 0)], [10, 10]);
});

test('next vests: a declined offer has none, and nothing vests after the job ends', async () => {
  const { get, send } = setup();
  const grant = { kind: 'rsu', shares: 1200, grantDate: '2026-01-15', cliffMonths: 0, vestMonths: 12, vestEveryMonths: 1 };
  const declined = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'declined' })).json();
  await send('POST', `/v1/jobs/${declined.id}/grants`, grant);
  assert.deepEqual((await get(`/v1/jobs/${declined.id}`)).json().nextVests, []);
  const past = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'past', startDate: '2026-01-01', endDate: '2026-05-01' })).json();
  await send('POST', `/v1/jobs/${past.id}/grants`, grant);
  assert.deepEqual((await get(`/v1/jobs/${past.id}`)).json().nextVests.map((v: { date: string }) => v.date), ['2026-04-15'], 'May 15 is after the May 1 end');
});

test('vesting: value-only grant splits cents with the remainder on the last event', () => {
  const g = { id: 'g2', kind: 'rsu', shares: null, valueCents: 100000, strikeCents: null, grantDate: '2026-03-31', cliffMonths: 0, vestMonths: 3, vestEveryMonths: 1 };
  assert.deepEqual(vestEvents(g, '2026-01-01', 5).map((e) => [e.date, e.valueCents]), [['2026-04-30', 33333], ['2026-05-31', 33333], ['2026-06-30', 33334]]);
});

test('vesting: whole shares per event with the remainder last, and a schedule that does not divide ends at vestMonths', () => {
  const g = { id: 'g3', shares: 10.5, valueCents: 1000, grantDate: '2026-01-31', cliffMonths: 0, vestMonths: 5, vestEveryMonths: 2 };
  assert.deepEqual(vestEvents(g, '2000-01-01', 9).map((e) => [e.date, e.shares, e.valueCents]), [['2026-03-31', 4, 400], ['2026-05-31', 4, 400], ['2026-06-30', 2.5, 200]]);
});

test('vesting: each event vests what accrued so far, so monthly 1000 shares after a 12-month cliff end on 21 and sum to 1000', () => {
  const g = { id: 'g4', shares: 1000, valueCents: null, grantDate: '2026-01-15', cliffMonths: 12, vestMonths: 48, vestEveryMonths: 1 };
  const events = vestEvents(g, '2000-01-01', 100);
  assert.equal(events.length, 37);
  assert.deepEqual([events[0]!.shares, events[1]!.shares, events.at(-1)!.shares], [250, 20, 21]);
  assert.equal(events.reduce((s, e) => s + e.shares!, 0), 1000);
});

const stub = { payDate: '2026-03-13', periodStart: '2026-02-28', periodEnd: '2026-03-13', grossCents: 400000, federalCents: 50000, stateCents: 15000,
  socialSecurityCents: 24800, medicareCents: 5800, retirementCents: 24000, otherDeductionsCents: 400, netCents: 280000 };
/** another stub with the same pay date and net, so not a duplicate */
const twinStub = { ...stub, grossCents: 400001, federalCents: 50001 };

test('pay stubs: create, validate the parts against net, patch, delete; the job detail lists them newest first', async () => {
  const { get, send } = setup();
  const job = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current' })).json();
  const made = await send('POST', '/v1/pay-stubs', { ...stub, jobId: job.id }, 'stub');
  assert.equal(made.statusCode, 201);
  const s = made.json();
  assert.deepEqual(s, { ...stub, id: s.id, jobId: job.id, otherPayCents: 0, ytdGrossCents: null, transactionIds: [], createdAt: '2026-03-15T12:00:00.000Z' });
  assert.deepEqual((await send('POST', '/v1/pay-stubs', { ...stub, jobId: job.id }, 'stub')).json(), s, 'one row per Idempotency-Key');
  assert.equal((await send('POST', '/v1/pay-stubs', { ...stub, netCents: 279999 })).statusCode, 201, 'within a cent');
  const again = await send('POST', '/v1/pay-stubs', { ...stub, jobId: job.id, periodStart: null }, 'stub-again');
  assert.deepEqual([again.statusCode, again.json().code], [409, 'DUPLICATE_STUB'], 'the same job, pay date, gross and net is saved once');
  assert.equal((await send('POST', '/v1/pay-stubs', { ...stub, netCents: 279999 }, 'jobless-again')).statusCode, 409, 'a stub without a job too');
  const next = await send('POST', '/v1/pay-stubs', { ...stub, jobId: job.id, payDate: '2026-03-27' });
  assert.equal(next.statusCode, 201, 'the next pay date is a new stub');
  await send('DELETE', `/v1/pay-stubs/${next.json().id}`);
  for (const [body, field] of [
    [{ ...stub, netCents: 279998 }, 'netCents'], [{ ...stub, netCents: 400001, grossCents: 400000 }, 'netCents'], [{ ...stub, grossCents: -1 }, 'grossCents'],
    [{ ...stub, periodEnd: '2026-02-27' }, 'periodEnd'], [{ ...stub, jobId: 'missing' }, 'jobId'],
    [{ ...stub, payDate: undefined }, 'payDate'], [{ ...stub, ssn: '000-00-0000' }, undefined], [{ ...stub, otherPayCents: -1 }, 'otherPayCents'],
    [{ ...stub, ytdGrossCents: 399999 }, 'ytdGrossCents'], [{ ...stub, payDate: '2206-03-13' }, 'payDate'], [{ ...stub, periodStart: '1999-12-31' }, 'periodStart'],
  ] as const) {
    const r = await send('POST', '/v1/pay-stubs', body);
    assert.deepEqual([r.statusCode, r.json().field], [400, field], JSON.stringify(body));
  }
  const extra = await send('POST', '/v1/pay-stubs', { ...stub, otherPayCents: 5000, netCents: 285000, ytdGrossCents: 400000 });
  assert.deepEqual([extra.statusCode, extra.json().otherPayCents], [201, 5000], 'after-tax additions make net more than gross minus deductions');
  assert.equal((await send('PATCH', `/v1/pay-stubs/${extra.json().id}`, { otherPayCents: null })).json().field, 'netCents', 'cleared other pay is 0');
  assert.equal((await send('PATCH', `/v1/pay-stubs/${extra.json().id}`, { ytdGrossCents: 1 })).json().field, 'ytdGrossCents', 'the merged stub is checked');
  const bonus = (await send('POST', '/v1/pay-stubs', { jobId: job.id, payDate: '2026-03-14', periodStart: null, periodEnd: null, grossCents: 1000, federalCents: 220, netCents: 780 })).json();
  assert.deepEqual([bonus.stateCents, bonus.otherDeductionsCents, bonus.periodStart], [0, 0, null], 'a bonus check may leave out its period and zero lines');
  assert.equal((await send('PATCH', `/v1/pay-stubs/${s.id}`, { netCents: 1 })).json().field, 'netCents', 'the merged stub is checked');
  const p = await send('PATCH', `/v1/pay-stubs/${s.id}`, { otherDeductionsCents: 0, netCents: 280400, ytdGrossCents: 2_400_000 });
  assert.deepEqual([p.statusCode, p.json().netCents, p.json().ytdGrossCents, p.json().payDate], [200, 280400, 2_400_000, '2026-03-13']);
  const zeroed = await send('PATCH', `/v1/pay-stubs/${bonus.id}`, { federalCents: null, netCents: 1000 });
  assert.deepEqual([zeroed.statusCode, zeroed.json().federalCents, zeroed.json().netCents], [200, 0, 1000], 'a cleared deduction line is 0');
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().stubs.map((x: { id: string }) => x.id), [bonus.id, s.id]);
  const jobless = (await get('/v1/pay-stubs/unassigned')).json().map((x: { id: string; jobId: string | null }) => [x.jobId, x.id]);
  assert.ok(jobless.length >= 2 && jobless.every(([j]: [string | null]) => j === null), 'stubs without a job are listed on their own');
  assert.equal((await send('PATCH', `/v1/pay-stubs/${jobless[0][1]}`, { jobId: job.id })).json().jobId, job.id, 'and can be given a job');
  assert.equal((await send('PATCH', '/v1/pay-stubs/missing', { netCents: 1 })).statusCode, 404);
  assert.equal((await send('DELETE', `/v1/pay-stubs/${s.id}`, undefined, 'd')).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/pay-stubs/${s.id}`, undefined, 'd')).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/pay-stubs/${s.id}`)).statusCode, 404);
});

test('stub matches: bank deposits within 3 days, at most the net, closest then newest, with singles and pairs that add up; never a deposit another stub holds', async () => {
  const { get, send, db } = setup();
  seedAccount(db, { id: 'chk' });
  seedAccount(db, { id: 'card', type: 'credit' });
  for (const [id, date, amountCents, removedAt] of [['a', '2026-03-13', 280000], ['b', '2026-03-12', 280000], ['c', '2026-03-14', 280000], ['far', '2026-03-17', 280000],
    ['early', '2026-03-10', 280000], ['out', '2026-03-13', -280000], ['over', '2026-03-13', 280001], ['gone', '2026-03-13', 280000, '2026-03-14T00:00:00Z'],
    ['half1', '2026-03-13', 200000], ['half2', '2026-03-13', 80000]] as const) {
    seedTxn(db, { id, accountId: 'chk', date, amountCents, ...(removedAt ? { removedAt } : {}) });
  }
  seedTxn(db, { id: 'refund', accountId: 'card', date: '2026-03-13', amountCents: 280000 });
  const s = (await send('POST', '/v1/pay-stubs', stub)).json();
  const matches = async (id: string) => {
    const m = (await get(`/v1/pay-stubs/${id}/matches`)).json();
    return [m.deposits.map((t: { id: string }) => t.id), m.suggestions];
  };
  assert.deepEqual(await matches(s.id), [['a', 'half1', 'half2', 'c', 'b', 'early'], [['a'], ['c'], ['b'], ['early'], ['half1', 'half2']]], 'a card refund is not a paycheck');
  assert.equal((await get('/v1/pay-stubs/missing/matches')).statusCode, 404);
  const link = (id: string, transactionIds: string[], key?: string) => send('PUT', `/v1/pay-stubs/${id}/link`, { transactionIds }, key);
  for (const ids of [['far'], ['refund'], ['half1'], ['a', 'a'], ['a', 'half2'], ['missing']]) {
    assert.deepEqual([(await link(s.id, ids)).json().field], ['transactionIds'], ids.join());
  }
  const linked = await link(s.id, ['half2', 'half1'], 'link');
  assert.deepEqual([linked.statusCode, linked.json().transactionIds], [200, ['half1', 'half2']], 'a paycheck split across two deposits');
  assert.equal((await link(s.id, ['half2', 'half1'], 'link')).statusCode, 200);
  assert.deepEqual((await matches(s.id))[0], ['a', 'half1', 'half2', 'c', 'b', 'early'], 'its own deposits stay listed');
  assert.deepEqual((await get('/v1/transactions/half2')).json().payStub, { id: s.id }, 'a deposit carries only the stub id');
  assert.deepEqual((await get(`/v1/pay-stubs/${s.id}`)).json(), linked.json());
  assert.equal((await get('/v1/pay-stubs/missing')).statusCode, 404);
  assert.equal((await get('/v1/transactions/a')).json().payStub, null);
  assert.deepEqual((await get('/v1/transactions?limit=20')).json().transactions.filter((x: { payStub: unknown }) => x.payStub).map((x: { id: string }) => x.id).sort(), ['half1', 'half2']);
  const twin = (await send('POST', '/v1/pay-stubs', twinStub)).json();
  assert.deepEqual(await matches(twin.id), [['a', 'c', 'b', 'early'], [['a'], ['c'], ['b'], ['early']]], 'deposits linked to another stub are never offered');
  const taken = await link(twin.id, ['half1', 'half2']);
  assert.deepEqual([taken.statusCode, taken.json().code], [409, 'ALREADY_LINKED']);
  assert.deepEqual((await send('PATCH', `/v1/pay-stubs/${s.id}`, { otherDeductionsCents: 300, retirementCents: 24100 })).json().transactionIds, ['half1', 'half2'],
    'an edit that still matches keeps the links');
  db.prepare("UPDATE transactions SET date = '2026-03-19' WHERE id = 'half1'").run();
  assert.equal((await send('PATCH', `/v1/pay-stubs/${s.id}`, { ytdGrossCents: 400000 })).json().transactionIds.length, 2, 'only an edit to net or pay date re-checks');
  assert.deepEqual((await send('PATCH', `/v1/pay-stubs/${s.id}`, { payDate: '2026-03-12' })).json().transactionIds, [], 'an edit the deposits no longer match drops them');
  db.prepare("UPDATE transactions SET date = '2026-03-13' WHERE id = 'half1'").run();
  await link(twin.id, ['c']);
  assert.deepEqual((await link(twin.id, [])).json().transactionIds, [], 'an empty list unlinks');
  assert.equal((await get('/v1/transactions/c')).json().payStub, null);
  await link(twin.id, ['a']);
  await send('DELETE', `/v1/pay-stubs/${twin.id}`);
  assert.equal((await get('/v1/transactions/a')).json().payStub, null, 'deleting the stub frees the deposit');
  const third = (await send('POST', '/v1/pay-stubs', stub)).json();
  await link(third.id, ['b']);
  db.prepare("UPDATE transactions SET removed_at = '2026-03-15T00:00:00Z' WHERE id = 'b'").run();
  assert.deepEqual((await get(`/v1/pay-stubs/${third.id}`)).json().transactionIds, [], 'a deposit Plaid removed is not linked');
  const gone = await link((await send('POST', '/v1/pay-stubs', { ...stub, grossCents: 400002, federalCents: 50002 })).json().id, ['b']);
  assert.deepEqual([gone.statusCode, gone.json().field], [400, 'transactionIds'], 'a removed deposit is not a match, even while another stub holds it');
  assert.equal((await send('PUT', `/v1/pay-stubs/${s.id}/link`, { transactionIds: ['a'], extra: 1 })).statusCode, 400);
  assert.equal((await send('PUT', `/v1/pay-stubs/${s.id}/link`, { transactionId: 'a' })).statusCode, 400);
});

test('a pending deposit whose posted row is here is never offered with it', async () => {
  const { get, send, db } = setup();
  seedAccount(db, { id: 'chk' });
  seedTxn(db, { id: 'pend', accountId: 'chk', date: '2026-03-12', amountCents: 140000, source: 'plaid', sourceId: 'p-1', pending: true });
  seedTxn(db, { id: 'posted', accountId: 'chk', date: '2026-03-13', amountCents: 140000, source: 'plaid', sourceId: 'p-2' });
  db.prepare("UPDATE transactions SET pending_source_id = 'p-1' WHERE id = 'posted'").run();
  seedTxn(db, { id: 'other', accountId: 'chk', date: '2026-03-13', amountCents: 140000 });
  const s = (await send('POST', '/v1/pay-stubs', stub)).json();
  const m = (await get(`/v1/pay-stubs/${s.id}/matches`)).json();
  assert.deepEqual([m.deposits.map((t: { id: string }) => t.id), m.suggestions], [['other', 'posted'], [['other', 'posted']]]);
  assert.equal((await send('PUT', `/v1/pay-stubs/${s.id}/link`, { transactionIds: ['pend', 'posted'] })).json().field, 'transactionIds');
});

const plaidSetup = async () => {
  const t = setup();
  seedAccount(t.db, { id: 'chk', plaidAccountId: 'pa-chk' });
  seedTxn(t.db, { id: 'pend', accountId: 'chk', date: '2026-03-13', amountCents: 280000, source: 'plaid', sourceId: 'p-pend', pending: true });
  const s = (await t.send('POST', '/v1/pay-stubs', stub)).json();
  await t.send('PUT', `/v1/pay-stubs/${s.id}/link`, { transactionIds: ['pend'] });
  const sync = (page: Partial<SyncPage>) => t.db.transaction(() => applyPages(t.db, [{ added: [], modified: [], removed: [], nextCursor: 'c', hasMore: false, ...page }],
    { itemId: 'item-x', cutoverDate: null, nowIso: '2026-03-16T00:00:00.000Z' }))();
  const posted = () => t.db.prepare("SELECT id FROM transactions WHERE source_id = 'posted'").pluck().get() as string;
  return { ...t, s, sync, posted };
};
const postedTxn = (pendingTransactionId: string | null) => txn({ transactionId: 'posted', pendingTransactionId, accountId: 'pa-chk', amount: -2800, date: '2026-03-14' });

test('a stub linked to a pending deposit follows the posted row', async () => {
  const { get, s, sync, posted } = await plaidSetup();
  sync({ added: [postedTxn('p-pend')] });
  assert.equal((await get(`/v1/transactions/${posted()}`)).json().payStub.id, s.id);
  assert.deepEqual((await get(`/v1/pay-stubs/${s.id}`)).json().transactionIds, [posted()]);
});

test('a posted row that learns its pending row in a later modification takes the stub link too', async () => {
  const { get, s, sync, posted } = await plaidSetup();
  sync({ added: [postedTxn(null)] });
  sync({ modified: [postedTxn('p-pend')] });
  assert.deepEqual((await get(`/v1/pay-stubs/${s.id}`)).json().transactionIds, [posted()]);
  assert.equal((await get(`/v1/transactions/${posted()}`)).json().payStub.id, s.id);
});

test('a posted row another stub already holds keeps that stub, the pending side is unlinked, and sync goes on', async () => {
  const { db, get, send, s, sync, posted } = await plaidSetup();
  sync({ added: [postedTxn(null)] });
  const other = (await send('POST', '/v1/pay-stubs', twinStub)).json();
  db.prepare('INSERT INTO pay_stub_deposits (stub_id, transaction_id) VALUES (?, ?)').run(other.id, posted());
  assert.doesNotThrow(() => sync({ modified: [postedTxn('p-pend')] }));
  assert.deepEqual((await get(`/v1/pay-stubs/${other.id}`)).json().transactionIds, [posted()]);
  assert.deepEqual((await get(`/v1/pay-stubs/${s.id}`)).json().transactionIds, []);
  assert.equal(db.prepare("SELECT COUNT(*) FROM pay_stub_deposits WHERE transaction_id = 'pend'").pluck().get(), 0);
});

test('Settings can check for the profile without loading it', async () => {
  const { get } = setup();
  assert.deepEqual((await get('/v1/profile/exists')).json(), { ok: true });
});

test('tax forms and returns: CRUD, upsert by year and jurisdiction, tax years newest first with the federal effective rate', async () => {
  const { get, send } = setup();
  const job = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current' })).json();
  const w2 = { jobId: job.id, year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 9_000_000, federalWithheldCents: 1_100_000, state: 'CA',
    stateWithheldCents: 380_000, ssWagesCents: 9_500_000, medicareWagesCents: 9_500_000 };
  const f = await send('POST', '/v1/tax-forms', w2, 'form');
  assert.equal(f.statusCode, 201);
  assert.deepEqual(f.json(), { ...w2, id: f.json().id, createdAt: '2026-03-15T12:00:00.000Z' });
  assert.deepEqual((await send('POST', '/v1/tax-forms', w2, 'form')).json(), f.json());
  for (const [body, field] of [
    [{ ...w2, kind: '1098' }, 'kind'], [{ ...w2, year: 1999 }, 'year'], [{ ...w2, year: 2028 }, 'year'], [{ ...w2, state: 'zz' }, 'state'],
    [{ ...w2, payer: '' }, 'payer'], [{ ...w2, jobId: 'missing' }, 'jobId'], [{ ...w2, amountCents: -1 }, 'amountCents'],
  ] as const) assert.equal((await send('POST', '/v1/tax-forms', body)).json().field, field, JSON.stringify(body));
  const int = (await send('POST', '/v1/tax-forms', { year: 2027, kind: '1099_int', payer: 'SYNTHETIC BANK', amountCents: 1200 })).json();
  assert.deepEqual([int.jobId, int.federalWithheldCents, int.state], [null, null, null]);
  assert.equal((await send('PATCH', `/v1/tax-forms/${int.id}`, { year: 2024 })).json().year, 2024);
  assert.equal((await send('PATCH', `/v1/tax-forms/${int.id}`, { year: 2030 })).json().field, 'year');
  assert.deepEqual((await get(`/v1/jobs/${job.id}`)).json().forms.map((x: { id: string }) => x.id), [f.json().id]);

  const fed = await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', filingStatus: 'single', totalIncomeCents: 9_000_000, totalTaxCents: 1_000_000, refundCents: -5000 }, 'ret');
  assert.equal(fed.statusCode, 200);
  assert.deepEqual((await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', filingStatus: 'single', totalIncomeCents: 9_000_000, totalTaxCents: 1_000_000, refundCents: -5000 }, 'ret')).json(), fed.json());
  const again = (await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', agiCents: 8_800_000 })).json();
  assert.deepEqual([again.id, again.totalTaxCents, again.agiCents, again.refundCents], [fed.json().id, 1_000_000, 8_800_000, -5000], 'upsert keeps left-out fields');
  await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'CA', totalTaxCents: 380_000 });
  await send('PUT', '/v1/tax-returns', { year: 2024, jurisdiction: 'federal', totalIncomeCents: 0, totalTaxCents: 0 });
  for (const [body, field] of [[{ year: 2025, jurisdiction: 'zz' }, 'jurisdiction'], [{ year: 2025, jurisdiction: 'state' }, 'jurisdiction'],
    [{ year: 1999, jurisdiction: 'federal' }, 'year'], [{ year: 2025, jurisdiction: 'federal', deductionKind: 'both' }, 'deductionKind']] as const) {
    assert.equal((await send('PUT', '/v1/tax-returns', body)).json().field, field, JSON.stringify(body));
  }
  const years = (await get('/v1/tax-years')).json().years;
  assert.deepEqual(years.map((y: { year: number; effectiveRate: number | null; returns: { jurisdiction: string }[]; forms: { id: string }[] }) =>
    [y.year, y.effectiveRate, y.returns.map((r) => r.jurisdiction), y.forms.map((x) => x.id)]),
  [[2025, 0.1111, ['federal', 'CA'], [f.json().id]], [2024, null, ['federal'], [int.id]]]);
  assert.equal((await send('DELETE', `/v1/tax-returns/${fed.json().id}`)).statusCode, 200);
  assert.equal((await get('/v1/tax-years')).json().years[0].effectiveRate, null, 'no federal return');
  assert.equal((await send('DELETE', `/v1/tax-returns/${fed.json().id}`)).statusCode, 404);
  assert.equal((await send('DELETE', `/v1/tax-forms/${int.id}`)).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/tax-forms/${int.id}`)).statusCode, 404);
  assert.deepEqual((await get('/v1/tax-years')).json().years.map((y: { year: number }) => y.year), [2025, 2024]);
});
