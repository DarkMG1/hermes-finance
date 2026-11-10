import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { purgeUnlinked } from '../src/documents.ts';
import { ProfileDrafts, type ProfileKind } from '@hermes/shared';
import { AUTH, makeTestDeps } from './helpers.ts';
import { stubRead } from './fake-reader.ts';

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
  const { send, read, docs, job, deps } = setup();
  const count = (table: string) => deps.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
  const jobId = await job();

  const stubs = await read(2);
  const a = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-02-27', grossCents: 1000, netCents: 1000, documentId: stubs })).json().id as string;
  const b = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-03-13', grossCents: 1000, netCents: 1000, documentId: stubs })).json().id as string;
  assert.deepEqual((await docs('pay_stub', a)).map((d) => d.id), [stubs]);
  assert.deepEqual((await docs('pay_stub', b)).map((d) => d.id), [stubs]);

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
  const formDoc = await read(1, 'tax_form');
  const form = (await send('POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100, documentId: formDoc })).json().id as string;
  const returnDoc = await read(1, 'tax_return');
  const ret = (await send('PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal', documentId: returnDoc })).json().id as string;
  const w4Doc = await read(1, 'w4');
  await send('PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single', documentId: w4Doc });
  const stateDoc = await read(1, 'state_w4');
  await send('PUT', `/v1/jobs/${jobId}/state-w4/XA`, { allowances: 1, documentId: stateDoc });
  await send('DELETE', `/v1/tax-forms/${form}`);
  await send('DELETE', `/v1/tax-returns/${ret}`);
  await send('DELETE', `/v1/jobs/${jobId}/w4`);
  await send('DELETE', `/v1/jobs/${jobId}/state-w4/XA`);
  assert.deepEqual([formDoc, returnDoc, w4Doc, stateDoc].map(exists), [false, false, false, false]);

  // a job's delete takes its W-4 and state forms with it, and their documents; its pay stubs stay (unassigned), and so does their document
  const offerDoc = await read(1, 'offer');
  const offer = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', documentId: offerDoc })).json().id as string;
  const w4b = await read(1, 'w4');
  await send('PUT', `/v1/jobs/${offer}/w4`, { filingStatus: 'single', documentId: w4b });
  const stateB = await read(1, 'state_w4');
  await send('PUT', `/v1/jobs/${offer}/state-w4/XB`, { allowances: 1, documentId: stateB });
  const stubs = await read(2);
  for (const payDate of ['2026-02-27', '2026-03-13']) await send('POST', '/v1/pay-stubs', { jobId: offer, payDate, grossCents: 2000, netCents: 2000, documentId: stubs });
  assert.equal((await send('DELETE', `/v1/jobs/${offer}`)).statusCode, 200);
  assert.deepEqual([offerDoc, w4b, stateB, stubs].map(exists), [false, false, false, true]);
  assert.deepEqual((await get(`/v1/documents/${stubs}`)).json().links.map((l: { recordType: string }) => l.recordType), ['pay_stub', 'pay_stub']);
});

test('re-saving a W-4, state form or tax return with a new document replaces its link; the same document re-sent stays', async () => {
  const { send, read, exists, job, docs, deps } = setup();
  const jobId = await job();
  for (const [kind, url, body, recordId] of [
    ['w4', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single' }, () => jobId],
    ['state_w4', `/v1/jobs/${jobId}/state-w4/XA`, { allowances: 1 }, () => `${jobId}:XA`],
    ['tax_return', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal' }, () => deps.db.prepare("SELECT id FROM tax_returns WHERE year = 2025").pluck().get() as string],
  ] as const) {
    const first = await read(1, kind);
    assert.equal((await send('PUT', url, { ...body, documentId: first })).statusCode, 200, kind);
    assert.equal((await send('PUT', url, { ...body, documentId: first })).statusCode, 200, kind);
    assert.deepEqual((await docs(kind, recordId())).map((d) => d.id), [first], `${kind}: the same document re-sent keeps its link`);
    const second = await read(1, kind);
    await send('PUT', url, { ...body, documentId: second });
    assert.deepEqual((await docs(kind, recordId())).map((d) => d.id), [second], kind);
    assert.ok(!exists(first), `${kind}: the replaced document, linked nowhere else, goes`);
  }
  // a replaced document still linked to another record stays
  const other = await job();
  const shared = await read(1, 'w4');
  await send('PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single', documentId: shared });
  await send('PUT', `/v1/jobs/${other}/w4`, { filingStatus: 'single', documentId: shared });
  await send('PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single', documentId: await read(1, 'w4') });
  assert.deepEqual((await docs('w4', other)).map((d) => d.id), [shared]);
  assert.equal((await docs('w4', jobId)).length, 1);
});

test('a document of another kind is a 400 that saves nothing', async () => {
  const { send, read, job, deps } = setup();
  const count = (table: string) => deps.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
  const jobId = await job();
  const stub = await read(1, 'pay_stub');
  const offer = await read(1, 'offer');
  const before = ['tax_forms', 'tax_returns', 'jobs', 'w4s', 'state_w4s', 'pay_stubs', 'document_links'].map(count);
  for (const [method, url, body, documentId] of [
    ['POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100 }, stub],
    ['PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal' }, stub],
    ['POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered' }, stub],
    ['PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single' }, offer],
    ['PUT', `/v1/jobs/${jobId}/state-w4/XA`, { allowances: 1 }, stub],
    ['POST', '/v1/pay-stubs', { payDate: '2026-01-02', grossCents: 1000, netCents: 1000 }, offer],
  ] as const) {
    const res = await send(method, url, { ...body, documentId });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().field, 'documentId', url);
  }
  assert.deepEqual(['tax_forms', 'tax_returns', 'jobs', 'w4s', 'state_w4s', 'pay_stubs', 'document_links'].map(count), before);
});

test('unlinked documents older than 24 hours are purged on each read and at startup; linked ones stay', async () => {
  const { deps, send, read, exists, job } = setup();
  const t0 = Date.parse('2026-03-15T12:00:00Z');
  const old = await read();
  const kept = await read(1, 'w4');
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
  const second = await read(2, 'w4');
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

const rereadOf = (app: ReturnType<typeof setup>['app'], id: string) => app.inject({ method: 'POST', url: `/v1/documents/${id}/read`, headers: AUTH });

test('re-reading a multi-stub document updates the stubs it saved (by pay date) and creates the rest', async () => {
  const { app, get, send, read, docs, job, profileReader, deps } = setup();
  const jobId = await job();
  const saveA = { payDate: '2026-02-27', grossCents: 1000, netCents: 1000 };
  const saveB = { payDate: '2026-03-13', grossCents: 2000, netCents: 2000 };
  const a = { employer: 'SYNTHETIC EMPLOYER', ...saveA };
  const b = { employer: 'SYNTHETIC EMPLOYER', ...saveB };
  profileReader.next = stubRead([a, b]);
  const doc = await read(2);
  const stubA = (await send('POST', '/v1/pay-stubs', { ...saveA, jobId, documentId: doc })).json().id as string;

  // the re-read corrects stub A's amounts: matched by pay date, not by the duplicate test
  profileReader.next = stubRead([{ ...a, grossCents: 1100, netCents: 1100 }, b]);
  const res = await rereadOf(app, doc);
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json();
  assert.equal(r.documentId, doc);
  assert.deepEqual(r.stubs.map((s: { recordId?: string }) => s.recordId), [stubA, undefined]);
  assert.deepEqual(profileReader.calls.at(-1)!.pages, [page(1), page(2)], 'the reader gets the stored pages');
  assert.equal(deps.db.prepare('SELECT COUNT(*) FROM documents').pluck().get(), 1, 'a re-read keeps no new copy');

  assert.equal((await send('PATCH', `/v1/pay-stubs/${stubA}`, { grossCents: 1100, netCents: 1100, documentId: doc })).statusCode, 200);
  const created = await send('POST', '/v1/pay-stubs', { ...saveB, jobId, documentId: doc });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await get(`/v1/pay-stubs/${stubA}`)).json().grossCents, 1100);
  assert.deepEqual((await docs('pay_stub', created.json().id)).map((d) => d.id), [doc]);
  assert.deepEqual((await docs('pay_stub', stubA)).map((d) => d.id), [doc]);

  // a fresh read of the same stubs finds both by the duplicate test
  profileReader.next = stubRead([{ ...a, grossCents: 1100, netCents: 1100 }, b]);
  const fresh = (await app.inject({ method: 'POST', url: '/v1/profile/read', headers: AUTH, payload: { kind: 'pay_stub', pages: [page(1).toString('base64')] } })).json();
  assert.deepEqual(fresh.stubs.map((s: { recordId?: string; saved: boolean }) => [s.recordId, s.saved]), [[stubA, true], [created.json().id, true]]);
});

test('reading a single-record kind returns the record it updates: the linked one on a re-read, an obvious existing one on a fresh read', async () => {
  const { app, send, read, job, profileReader, deps } = setup();
  const jobId = await job();
  const single = (kind: ProfileKind, draft: object) => { profileReader.next = { kind, draft: ProfileDrafts[kind].parse(draft), uncertain: [], model: 'fake-model' } as never; };
  const freshRead = async (kind: ProfileKind) => (await app.inject({ method: 'POST', url: '/v1/profile/read', headers: AUTH, payload: { kind, pages: [page(1).toString('base64')] } })).json();
  const returnId = () => deps.db.prepare('SELECT id FROM tax_returns').pluck().get() as string;
  const formId = () => deps.db.prepare('SELECT id FROM tax_forms').pluck().get() as string;
  for (const [kind, draft, method, url, body, recordId] of [
    ['w4', { employer: 'synthetic employer ', filingStatus: 'single' }, 'PUT', `/v1/jobs/${jobId}/w4`, { filingStatus: 'single' }, () => jobId],
    ['state_w4', { employer: 'SYNTHETIC EMPLOYER', state: 'XA', allowances: 1 }, 'PUT', `/v1/jobs/${jobId}/state-w4/XA`, { allowances: 1 }, () => `${jobId}:XA`],
    ['tax_return', { year: 2025, jurisdiction: 'federal' }, 'PUT', '/v1/tax-returns', { year: 2025, jurisdiction: 'federal' }, returnId],
    ['tax_form', { year: 2025, kind: 'w2', payer: 'Synthetic Employer', amountCents: 100 }, 'POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100 }, formId],
  ] as const) {
    single(kind, draft);
    const first = await freshRead(kind);
    assert.equal(first.recordId, undefined, `${kind}: nothing saved yet`);
    assert.ok([200, 201].includes((await send(method, url, { ...body, documentId: first.documentId })).statusCode), kind);
    const again = await rereadOf(app, first.documentId);
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual([again.json().recordId, again.json().documentId], [recordId(), first.documentId], `${kind}: re-read`);
    assert.equal((await freshRead(kind)).recordId, recordId(), `${kind}: fresh read finds the saved one`);
  }
  // a state form for another state, or a W-4 when two jobs share the employer name, isn't obvious
  single('state_w4', { employer: 'SYNTHETIC EMPLOYER', state: 'XB' });
  assert.equal((await freshRead('state_w4')).recordId, undefined);
  await send('PUT', `/v1/jobs/${await job()}/w4`, { filingStatus: 'single' });
  single('w4', { employer: 'SYNTHETIC EMPLOYER' });
  assert.equal((await freshRead('w4')).recordId, undefined);

  // an offer: the linked job on a re-read; a fresh offer from a known employer can be a new job
  single('offer', { employer: 'SYNTHETIC EMPLOYER', baseCents: 100 });
  const offerDoc = await read(1, 'offer');
  assert.equal((await freshRead('offer')).recordId, undefined);
  const offer = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', documentId: offerDoc })).json().id as string;
  assert.equal((await rereadOf(app, offerDoc)).json().recordId, offer);
});

test('PATCH links a document: stubs and forms add a link, a job replaces its offer document; a bad documentId saves nothing', async () => {
  const { send, read, docs, exists, job, deps } = setup();
  const jobId = await job();
  const stubId = (await send('POST', '/v1/pay-stubs', { jobId, payDate: '2026-02-27', grossCents: 1000, netCents: 1000 })).json().id as string;
  const formId = (await send('POST', '/v1/tax-forms', { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER', amountCents: 100 })).json().id as string;
  const offerId = (await send('POST', '/v1/jobs', { employer: 'SYNTHETIC EMPLOYER', status: 'offered', documentId: await read(1, 'offer') })).json().id as string;
  const [oldOffer] = (await docs('job', offerId)).map((d) => d.id);
  const offer = await read(1, 'offer');
  for (const [url, recordType, recordId, documentId, body] of [
    [`/v1/pay-stubs/${stubId}`, 'pay_stub', stubId, await read(1, 'pay_stub'), { netCents: 1000 }],
    [`/v1/tax-forms/${formId}`, 'tax_form', formId, await read(1, 'tax_form'), { amountCents: 200 }],
    [`/v1/jobs/${offerId}`, 'job', offerId, offer, { baseCents: 100 }],
  ] as const) {
    const before = deps.db.prepare('SELECT COUNT(*) FROM document_links').pluck().get();
    for (const bad of ['nope', recordType === 'job' ? await read(1, 'w4') : await read(1, 'offer')]) {
      const res = await send('PATCH', url, { ...body, documentId: bad });
      assert.deepEqual([res.statusCode, res.json().field], [400, 'documentId'], url);
    }
    assert.equal(deps.db.prepare('SELECT COUNT(*) FROM document_links').pluck().get(), before);
    assert.equal((await send('PATCH', url, { documentId }, `p-${recordType}`)).statusCode, 200, url);
    assert.equal((await send('PATCH', url, { documentId }, `p-${recordType}`)).statusCode, 200, `${url}: a retried PATCH replays`);
    assert.ok((await docs(recordType, recordId)).some((d) => d.id === documentId), url);
  }
  assert.equal(deps.db.prepare('SELECT amount_cents FROM tax_forms').pluck().get(), 100, 'a refused PATCH changes nothing');
  assert.deepEqual((await docs('job', offerId)).map((d) => d.id), [offer]);
  assert.ok(!exists(oldOffer!), 'the replaced offer document goes');
});

test('a re-read shares the reader guard; an unknown document is 404', async () => {
  const { app, read, profileReader } = setup();
  const doc = await read();
  assert.equal((await rereadOf(app, 'nope')).statusCode, 404);
  let release!: () => void;
  profileReader.hold = new Promise<void>((r) => { release = r; });
  const busy = app.inject({ method: 'POST', url: '/v1/profile/read', headers: AUTH, payload: { kind: 'pay_stub', pages: [page(1).toString('base64')] } });
  while (profileReader.calls.length < 2) await new Promise((r) => setImmediate(r));
  const res = await rereadOf(app, doc);
  assert.deepEqual([res.statusCode, res.json().code], [409, 'READ_IN_PROGRESS']);
  release();
  assert.equal((await busy).statusCode, 200);
});
