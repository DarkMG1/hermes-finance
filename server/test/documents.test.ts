import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileDrafts } from '@hermes/shared';
import { buildApp } from '../src/app.ts';
import { purgeUnlinked } from '../src/documents.ts';
import { AUTH, makeTestDeps } from './helpers.ts';

const page = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, n, n]);

function setup() {
  const t = makeTestDeps();
  const app = buildApp(t.deps);
  let n = 0;
  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, key = `k${(n += 1)}`) =>
    app.inject({ method, url, headers: { ...AUTH, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  /** reads `pages` pages and returns the kept document's id */
  const read = async (pages = 1, kind = 'pay_stub') => {
    const res = await app.inject({ method: 'POST', url: '/v1/profile/read', headers: AUTH,
      payload: { kind, pages: Array.from({ length: pages }, (_, i) => page(i + 1).toString('base64')) } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().documentId as string;
  };
  const docs = async (recordType: string, recordId: string) => (await get(`/v1/documents?recordType=${recordType}&recordId=${encodeURIComponent(recordId)}`)).json().documents as { id: string }[];
  const exists = (id: string) => !!t.deps.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id);
  const job = async () => (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'current' })).json().id as string;
  return { ...t, app, get, send, read, docs, exists, job };
}

test('a read keeps exactly its pages, served one by one; out of range or unknown is 404', async () => {
  const { get, read, profileReader } = setup();
  const id = await read(3);
  assert.equal(profileReader.calls.length, 1);
  const doc = (await get(`/v1/documents/${id}`)).json();
  assert.deepEqual(doc, { id, kind: 'pay_stub', createdAt: '2026-03-15T12:00:00.000Z', pageCount: 3, links: [] });
  for (const n of [1, 2, 3]) {
    const res = await get(`/v1/documents/${id}/pages/${n}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.deepEqual(res.rawPayload, page(n));
  }
  for (const n of ['0', '4', 'x']) assert.equal((await get(`/v1/documents/${id}/pages/${n}`)).statusCode, 404, n);
  assert.equal((await get('/v1/documents/nope')).statusCode, 404);
  assert.equal((await get('/v1/documents/nope/pages/1')).statusCode, 404);
});

test('a failed read keeps nothing', async () => {
  const { app, profileReader, get } = setup();
  profileReader.next = new Error('boom');
  const res = await app.inject({ method: 'POST', url: '/v1/profile/read', headers: AUTH, payload: { kind: 'w4', pages: [page(1).toString('base64')] } });
  assert.equal(res.statusCode, 502);
  assert.deepEqual((await get('/v1/documents')).json(), { documents: [] });
});

test('every save route links its document; an unknown documentId is a 400 that saves nothing', async () => {
  const { send, read, docs, job, profileReader, deps } = setup();
  const count = (table: string) => deps.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
  const jobId = await job();

  const stubs = await read(2);
  const a = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-02-27', grossCents: 1000, netCents: 1000, documentId: stubs })).json().id as string;
  const b = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-03-13', grossCents: 1000, netCents: 1000, documentId: stubs })).json().id as string;
  assert.deepEqual((await docs('pay_stub', a)).map((d) => d.id), [stubs]);
  assert.deepEqual((await docs('pay_stub', b)).map((d) => d.id), [stubs]);

  profileReader.next = { kind: 'tax_form', model: 'fake-model', uncertain: [], draft: ProfileDrafts.tax_form.parse({}) };
  const formDoc = await read(1, 'tax_form');
  const form = (await send('POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100, documentId: formDoc })).json().id as string;
  assert.deepEqual((await docs('tax_form', form)).map((d) => d.id), [formDoc]);

  const returnDoc = await read(1, 'tax_return');
  const ret = (await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', documentId: returnDoc })).json().id as string;
  assert.deepEqual((await docs('tax_return', ret)).map((d) => d.id), [returnDoc]);

  const offerDoc = await read(1, 'offer');
  const offer = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', documentId: offerDoc })).json().id as string;
  assert.deepEqual((await docs('job', offer)).map((d) => d.id), [offerDoc]);

  const w4Doc = await read(1, 'w4');
  assert.equal((await send('PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single', documentId: w4Doc })).statusCode, 200);
  assert.deepEqual((await docs('w4', jobId)).map((d) => d.id), [w4Doc]);

  const stateDoc = await read(1, 'state_w4');
  assert.equal((await send('PUT', `/v1/jobs/${jobId}/state-w4/XA`, { allowances: 1, documentId: stateDoc })).statusCode, 200);
  assert.deepEqual((await docs('state_w4', `${jobId}:XA`)).map((d) => d.id), [stateDoc]);

  const before = ['pay_stubs', 'tax_forms', 'tax_returns', 'jobs', 'w4s', 'state_w4s', 'document_links'].map(count);
  for (const [method, url, body] of [
    ['POST', '/v1/pay-stubs', { payDate: '2026-01-02', grossCents: 1000, netCents: 1000 }],
    ['POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100 }],
    ['PUT', '/v1/tax-returns', { year: 2024, jurisdiction: 'federal' }],
    ['POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered' }],
    ['PUT', `/v1/jobs/${offer}/w4`, { filingStatus: 'single' }],
    ['PUT', `/v1/jobs/${offer}/state-w4/XB`, { allowances: 1 }],
  ] as const) {
    const res = await send(method, url, { ...body, documentId: 'nope' });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().field, 'documentId', url);
  }
  assert.deepEqual(['pay_stubs', 'tax_forms', 'tax_returns', 'jobs', 'w4s', 'state_w4s', 'document_links'].map(count), before);
});

test('deleting a record keeps a document still linked elsewhere; the last link takes it', async () => {
  const { send, read, exists, job, get } = setup();
  const jobId = await job();
  const doc = await read(2);
  const a = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-02-27', grossCents: 1000, netCents: 1000, documentId: doc })).json().id as string;
  const b = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-03-13', grossCents: 1000, netCents: 1000, documentId: doc })).json().id as string;
  assert.equal((await send('DELETE', `/v1/pay-stubs/${a}`)).statusCode, 200);
  assert.ok(exists(doc));
  assert.deepEqual((await get(`/v1/documents/${doc}`)).json().links, [{ recordType: 'pay_stub', recordId: b }]);
  assert.equal((await send('DELETE', `/v1/pay-stubs/${b}`)).statusCode, 200);
  assert.ok(!exists(doc));

  // the other record deletes, each the last link of its document
  const formDoc = await read();
  const form = (await send('POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100, documentId: formDoc })).json().id as string;
  const returnDoc = await read();
  const ret = (await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', documentId: returnDoc })).json().id as string;
  const w4Doc = await read();
  await send('PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single', documentId: w4Doc });
  const stateDoc = await read();
  await send('PUT', `/v1/jobs/${jobId}/state-w4/XA`, { allowances: 1, documentId: stateDoc });
  await send('DELETE', `/v1/tax-forms/${form}`);
  await send('DELETE', `/v1/tax-returns/${ret}`);
  await send('DELETE', `/v1/jobs/${jobId}/w4`);
  await send('DELETE', `/v1/jobs/${jobId}/state-w4/XA`);
  assert.deepEqual([formDoc, returnDoc, w4Doc, stateDoc].map(exists), [false, false, false, false]);

  // a job's delete takes its W-4 and state forms with it, and their documents
  const offerDoc = await read();
  const offer = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', documentId: offerDoc })).json().id as string;
  const w4b = await read();
  await send('PUT', `/v1/jobs/${offer}/w4`, { filingStatus: 'single', documentId: w4b });
  const stateB = await read();
  await send('PUT', `/v1/jobs/${offer}/state-w4/XB`, { allowances: 1, documentId: stateB });
  const shared = await read();
  await send('PUT', `/v1/jobs/${offer}/state-w4/XA`, { allowances: 1, documentId: shared });
  await send('POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100, documentId: shared });
  assert.equal((await send('DELETE', `/v1/jobs/${offer}`)).statusCode, 200);
  assert.deepEqual([offerDoc, w4b, stateB, shared].map(exists), [false, false, false, true]);
  assert.deepEqual((await get(`/v1/documents/${shared}`)).json().links.map((l: { recordType: string }) => l.recordType), ['tax_form']);
});

test('unlinked documents older than 24 hours are purged on each read and at startup; linked ones stay', async () => {
  const { deps, send, read, exists, job } = setup();
  const t0 = Date.parse('2026-03-15T12:00:00Z');
  const old = await read();
  const kept = await read();
  await send('PUT', `/v1/jobs/${await job()}/w4`, { filingStatus: 'single', documentId: kept });
  deps.now = () => new Date(t0 + 24 * 3_600_000);
  const young = await read();
  assert.ok(exists(old), 'exactly 24 hours is not older');
  deps.now = () => new Date(t0 + 24 * 3_600_000 + 1);
  await read();
  assert.deepEqual([old, kept, young].map(exists), [false, true, true]);
  assert.equal(purgeUnlinked(deps.db, new Date(t0 + 49 * 3_600_000)), 2);
  assert.ok(exists(kept));
});

test('the list is newest first and filters by record; DELETE drops the pages and keeps the record', async () => {
  const { deps, get, send, read, job } = setup();
  const jobId = await job();
  const first = await read();
  deps.now = () => new Date('2026-03-15T13:00:00Z');
  const second = await read(2);
  await send('PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single', documentId: second });
  const all = (await get('/v1/documents')).json().documents as { id: string; pageCount: number; links: unknown[] }[];
  assert.deepEqual(all.map((d) => [d.id, d.pageCount, d.links]), [[second, 2, [{ recordType: 'w4', recordId: jobId }]], [first, 1, []]]);
  assert.deepEqual((await get(`/v1/documents?recordType=w4&recordId=${jobId}`)).json().documents.map((d: { id: string }) => d.id), [second]);
  assert.equal((await get('/v1/documents?recordType=bogus&recordId=x')).json().field, 'recordType');

  assert.equal((await send('DELETE', `/v1/documents/${second}`, undefined, 'del')).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/documents/${second}`, undefined, 'del')).statusCode, 200, 'a retried delete replays');
  assert.equal((await send('DELETE', `/v1/documents/${second}`)).statusCode, 404);
  assert.equal((await get(`/v1/documents/${second}/pages/1`)).statusCode, 404);
  assert.equal(deps.db.prepare('SELECT COUNT(*) FROM document_pages WHERE document_id = ?').pluck().get(second), 0);
  assert.equal((await get(`/v1/jobs/${jobId}`)).json().w4.filingStatus, 'single');
});
