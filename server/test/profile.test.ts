import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { migrate, openDb } from '../src/db.ts';
import { vestEvents } from '../src/profile.ts';
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
  const put = await send('PUT', '/v1/profile', { state: 'MI', filingStatus: 'single', birthYear: 2004, dependents: 0, retirementPct: 6, retirementKind: 'roth', hsa: true }, 'same');
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), (await send('PUT', '/v1/profile', { state: 'MI', filingStatus: 'single', birthYear: 2004, dependents: 0, retirementPct: 6, retirementKind: 'roth', hsa: true }, 'same')).json());
  const p = (await send('PUT', '/v1/profile', { note: 'Synthetic note', hsa: null })).json();
  assert.deepEqual([p.state, p.retirementPct, p.hsa, p.note, p.updatedAt], ['MI', 6, null, 'Synthetic note', '2026-03-15T12:00:00.000Z']);
  assert.deepEqual((await get('/v1/profile')).json(), p);
});

test('About me rejects bad values with the field', async () => {
  const { send } = setup();
  for (const [body, field] of [
    [{ filingStatus: 'joint' }, 'filingStatus'], [{ birthYear: 1899 }, 'birthYear'], [{ birthYear: 2027 }, 'birthYear'],
    [{ dependents: 21 }, 'dependents'], [{ dependents: -1 }, 'dependents'], [{ retirementPct: 100.5 }, 'retirementPct'],
    [{ note: 'x'.repeat(2001) }, 'note'], [{ state: 'mi' }, 'state'], [{ ssn: '000-00-0000' }, undefined],
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
  assert.equal((await send('POST', '/v1/jobs', { status: 'current' })).json().field, 'employer');
  assert.equal((await send('POST', '/v1/jobs', { employer: 'X', status: 'past', startDate: '2026-02-01', endDate: '2026-01-31' })).json().field, 'endDate');
  assert.equal((await send('PATCH', `/v1/jobs/${job.id}`, { endDate: '2026-05-31' })).json().field, 'endDate', 'checked against the saved start date');
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
    [{ ...base, strikeCents: 100 }, 'strikeCents'],
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
    medicare_cents, retirement_cents, other_deductions_cents, net_cents, transaction_id, created_at) VALUES ('s1', ?, '2026-01-02', '2025-12-16', '2025-12-31', 100, 10, 5, 6, 2, 5, 2, 70, 'pay', 'x')`).run(job.id);
  db.prepare("INSERT INTO tax_forms (id, job_id, year, kind, payer, amount_cents, created_at) VALUES ('f1', ?, 2025, 'w2', 'SYNTHETIC EMPLOYER', 100, 'x')").run(job.id);
  assert.equal((await send('DELETE', `/v1/jobs/${job.id}`)).statusCode, 200);
  assert.equal(count(db, 'equity_grants'), 0);
  assert.deepEqual(db.prepare("SELECT job_id, transaction_id FROM pay_stubs WHERE id = 's1'").get(), { job_id: null, transaction_id: 'pay' });
  assert.equal(db.prepare("SELECT job_id FROM tax_forms WHERE id = 'f1'").pluck().get(), null);
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
  assert.equal(migrate(db), 28);
  assert.deepEqual(db.prepare('SELECT feature, cost_microdollars AS c FROM ai_usage').all(), [{ feature: 'receipt', c: 7 }]);
  ins.run('profile');
  assert.throws(() => ins.run('other'), /CHECK/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ai_usage_month'").get());
  assert.throws(() => db.prepare('INSERT INTO profile (id) VALUES (2)').run(), /CHECK/);
});

test('vesting: 4-year RSU, 12-month cliff, quarterly after', () => {
  const g = { id: 'g1', kind: 'rsu', shares: 400, valueCents: null, strikeCents: null, grantDate: '2026-01-15', cliffMonths: 12, vestMonths: 48, vestEveryMonths: 3 };
  assert.deepEqual(vestEvents(g, '2026-01-15', 3).map((e) => [e.date, e.shares]), [['2027-01-15', 100], ['2027-04-15', 25], ['2027-07-15', 25]]);
  assert.equal(vestEvents(g, '2031-01-01', 4).length, 0, 'fully vested');
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
