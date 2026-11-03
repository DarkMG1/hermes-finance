import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileDrafts } from '@hermes/shared';
import { buildApp } from '../src/app.ts';
import { createClaude } from '../src/chat/anthropic.ts';
import { createAnthropicProfileReader, scrubIdentifiers } from '../src/profile-reader.ts';
import { ReaderError } from '../src/receipt-reader.ts';
import { AUTH, makeTestDeps } from './helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PAGE = JPEG.toString('base64');

function setup() {
  const t = makeTestDeps();
  const app = buildApp(t.deps);
  const read = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/profile/read', headers: AUTH, payload: payload as object });
  return { ...t, read };
}

const counts = (db: ReturnType<typeof setup>['deps']['db']) => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[])
  .map((t) => [t, db.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get()]));

test('a read returns the draft with identifiers blanked and stores nothing', async () => {
  const { deps, read, profileReader } = setup();
  profileReader.next = { kind: 'tax_form', model: 'fake-model', uncertain: ['stateWithheldCents', 'not a field', '000-00-0000'],
    draft: ProfileDrafts.tax_form.parse({ year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER 00-0000000', amountCents: 6500000, state: 'CA' }) };
  const before = counts(deps.db);
  for (let i = 0; i < 2; i += 1) {
    const res = await read({ kind: 'tax_form', pages: [PAGE, PAGE] });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual([body.kind, body.draft.payer, body.draft.amountCents, body.draft.state, body.draft.ssWagesCents, body.uncertain],
      ['tax_form', null, 6500000, 'CA', null, ['stateWithheldCents']]);
    assert.equal(body.model, undefined);
  }
  assert.deepEqual(counts(deps.db), before);
  assert.equal(profileReader.calls.length, 2);
  assert.deepEqual(profileReader.calls[0], { kind: 'tax_form', pages: [JPEG, JPEG] });
});

test('the body is checked: kind, 1 to 8 JPEG pages, at most 3 MB', async () => {
  const { read, profileReader } = setup();
  for (const [payload, field] of [
    [{ kind: 'passport', pages: [PAGE] }, 'kind'],
    [{ kind: 'offer', pages: [] }, 'pages'],
    [{ kind: 'offer', pages: Array(9).fill(PAGE) }, 'pages'],
    [{ kind: 'offer', pages: [PAGE, Buffer.from('not a jpeg').toString('base64')] }, 'pages.1'],
    [{ kind: 'offer', pages: [PAGE], extra: 1 }, undefined],
  ] as const) {
    const res = await read(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().field, field);
  }
  const big = await read({ kind: 'offer', pages: [Buffer.concat([JPEG, Buffer.alloc(2_400_000)]).toString('base64')] });
  assert.equal(big.statusCode, 413);
  const fits = await read({ kind: 'offer', pages: [Buffer.concat([JPEG, Buffer.alloc(2_100_000)]).toString('base64')] });
  assert.equal(fits.statusCode, 200);
  assert.equal(profileReader.calls.length, 1);
});

test('reader errors map to 503, 402, 422 and 502', async () => {
  const { deps, read, profileReader } = setup();
  for (const [error, status, code] of [
    [new ReaderError('AI_CREDITS_EXHAUSTED'), 402, 'AI_CREDITS_EXHAUSTED'],
    [new ReaderError('INVALID_OUTPUT'), 422, 'UNREADABLE'],
    [new ReaderError('TIMEOUT'), 502, 'READ_FAILED'],
    [new Error('boom'), 502, 'READ_FAILED'],
  ] as const) {
    profileReader.next = error;
    const res = await read({ kind: 'pay_stub', pages: [PAGE] });
    assert.deepEqual([res.statusCode, res.json().code], [status, code]);
  }
  (deps as { profileReader: unknown }).profileReader = null;
  const off = await read({ kind: 'pay_stub', pages: [PAGE] });
  assert.deepEqual([off.statusCode, off.json().code], [503, 'READER_NOT_CONFIGURED']);
});

test('one read at a time', async () => {
  const { read, profileReader } = setup();
  let release!: () => void;
  profileReader.hold = new Promise<void>((r) => { release = r; });
  const first = read({ kind: 'offer', pages: [PAGE] });
  await new Promise((r) => setImmediate(r));
  const second = await read({ kind: 'tax_return', pages: [PAGE] });
  assert.deepEqual([second.statusCode, second.json().code], [409, 'READ_IN_PROGRESS']);
  release();
  assert.equal((await first).statusCode, 200);
  profileReader.hold = undefined;
  profileReader.next = new ReaderError('TIMEOUT');
  assert.equal((await read({ kind: 'offer', pages: [PAGE] })).statusCode, 502);
  profileReader.next = { kind: 'offer', model: 'm', uncertain: [], draft: ProfileDrafts.offer.parse({}) };
  assert.equal((await read({ kind: 'offer', pages: [PAGE] })).statusCode, 200, 'a failed read frees the guard');
});

test('scrubIdentifiers blanks SSN, ITIN and EIN shaped strings anywhere and keeps the rest', () => {
  const draft = { payer: 'SYNTHETIC EMPLOYER', note: 'ssn 000-00-0000', itin: '900 70 0000', bare: '900700000', ein: '00-0000000', amountCents: 123456789,
    date: '2026-03-14', zip: '00000', phone: '(000) 000-0000', grants: [{ note: 'EIN 00-0000000', shares: 10 }], empty: null };
  assert.deepEqual(scrubIdentifiers(draft), { payer: 'SYNTHETIC EMPLOYER', note: null, itin: null, bare: null, ein: null, amountCents: 123456789,
    date: '2026-03-14', zip: '00000', phone: '(000) 000-0000', grants: [{ note: null, shares: 10 }], empty: null });
  for (const s of ['000\u201300\u20130000', '000\u201400\u20140000', '000.00.0000', '000  00   0000', '00\u20130000000', '00\u20140000000', '00.0000000', '00   0000000']) {
    assert.equal(scrubIdentifiers(s), null, s);
  }
  for (const s of ['$1,234.56', '000.000.0000', '000-000-0000', '2026.03.14', '00000-0000']) assert.equal(scrubIdentifiers(s), s, s);
});

test("scrubIdentifiers follows the app's rules: digits bound an identifier, and account or routing numbers go with their word", () => {
  for (const s of ['SSN000-00-0000', 'EIN00-0000000', 'ID000000000', 'x000-00-0000y', 'Account 00001234567', 'Routing 000000000', 'acct# 1234 5678 9012',
    'Acct 1234-5678-90', 'ABA:000000000', 'Direct deposit account 0000 1234 5678.']) assert.equal(scrubIdentifiers(s), null, s);
  for (const s of ['$000000000', '000000000.00', '$00-0000000', 'Account ending in 1234', 'Account opened 2026-04-15', '00001234567 transfers',
    'Account total $00001234567.00', 'Accounting 00001234567', 'Synthetic City, ST 00000-0000', 'Phone 1234 5678 9012']) assert.equal(scrubIdentifiers(s), s, s);
});

test('uncertain keeps only the draft\'s own field names', async () => {
  const { read, profileReader } = setup();
  profileReader.next = { kind: 'tax_form', model: 'm', uncertain: ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'payer'],
    draft: ProfileDrafts.tax_form.parse({ payer: 'SYNTHETIC EMPLOYER' }) };
  assert.deepEqual((await read({ kind: 'tax_form', pages: [PAGE] })).json().uncertain, ['payer']);
});

const makeReader = (fetchFn: typeof fetch) => {
  const { deps } = makeTestDeps();
  return { deps, reader: createAnthropicProfileReader(createClaude(deps, fetchFn)!, 'claude-sonnet-5-5') };
};
const reply = (content: unknown) => async () => new Response(JSON.stringify({ content, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });

test('an offer read leaves pay it does not state blank instead of zero, and asks for no worked-out salary', async () => {
  let text = '';
  const { reader } = makeReader(async (_url, init) => {
    text = (JSON.parse(String(init!.body)) as { messages: { content: { text?: string }[] }[] }).messages[0]!.content.at(-1)!.text!;
    return reply([{ type: 'tool_use', name: 'record_offer', input: { employer: 'SYNTHETIC EMPLOYER', baseCents: 0, hourlyCents: 3750, hoursPerWeek: 20, bonusTargetPct: 0, signingBonusCents: 0, relocationCents: 250000, grants: [] } }])();
  });
  const r = await reader.read('offer', [JPEG]);
  assert.ok(r.kind === 'offer');
  assert.deepEqual([r.draft.baseCents, r.draft.hourlyCents, r.draft.hoursPerWeek, r.draft.bonusTargetPct, r.draft.signingBonusCents, r.draft.relocationCents], [null, 3750, 20, null, null, 250000]);
  assert.match(text, /null for hourly pay.*never work one out.*hourlyCents: the hourly rate.*hoursPerWeek: the weekly hours/s);
});

test('the Anthropic reader sends every page and one tool per kind, without forcing it, and records profile usage', async () => {
  for (const kind of ['tax_return', 'tax_form', 'pay_stub', 'offer'] as const) {
    const sent: { model: string; tool_choice?: unknown; tools: { name: string; input_schema: { properties: Record<string, unknown> } }[];
      messages: { content: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] }[] }[] = [];
    const input = { offer: { employer: 'SYNTHETIC EMPLOYER', baseCents: 12000000,
      grants: [{ kind: 'rsu', shares: 400, grantDate: '2026-01-15', vestMonths: 48 }, 'junk', ...Array.from({ length: 20 }, (_, i) => ({ shares: i + 1 }))] },
      pay_stub: { employer: 'SYNTHETIC EMPLOYER', payDate: '2026-03-13', grossCents: 420000, netCents: 'lots' },
      tax_form: { year: 2025, kind: 'w2', payer: 'SYNTHETIC EMPLOYER' }, tax_return: { year: 2025, jurisdiction: 'federal', refundCents: -5000 } }[kind];
    const { deps, reader } = makeReader(async (_url, init) => {
      sent.push(JSON.parse(String(init!.body)));
      return reply([{ type: 'text', text: 'Reading.' }, { type: 'tool_use', name: `record_${kind}`, input: { ...input, uncertain: ['grossCents'], extra: 'dropped' } }])();
    });
    const r = await reader.read(kind, [JPEG, Buffer.from([0xff, 0xd8, 0xff, 9])]);
    assert.equal(sent.length, 1);
    const body = sent[0]!;
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.tool_choice, undefined);
    assert.deepEqual(body.tools.map((t) => t.name), [`record_${kind}`]);
    assert.ok('uncertain' in body.tools[0]!.input_schema.properties);
    const content = body.messages[0]!.content;
    assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'text']);
    assert.deepEqual(content[0]!.source, { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') });
    assert.match(content[2]!.text!, new RegExp(`Call record_${kind} once`));
    assert.match(content[2]!.text!, /Never return SSNs, ITINs, EINs or account numbers/);
    assert.deepEqual([r.kind, r.uncertain, r.model], [kind, ['grossCents'], 'claude-sonnet-5-5']);
    assert.equal((r.draft as Record<string, unknown>).extra, undefined);
    assert.deepEqual(deps.db.prepare('SELECT feature, model FROM ai_usage').all(), [{ feature: 'profile', model: 'claude-sonnet-5-5' }]);
    // a malformed grant is dropped, not the whole list, and the list stops at 20
    if (r.kind === 'offer') assert.deepEqual([r.draft.baseCents, r.draft.grants.length, r.draft.grants[0]!.shares, r.draft.grants[0]!.cliffMonths, r.draft.grants[19]!.shares],
      [12000000, 20, 400, null, 19]);
    // a value that doesn't fit becomes null for the owner to fill in
    if (r.kind === 'pay_stub') assert.deepEqual([r.draft.grossCents, r.draft.netCents, r.draft.employer], [420000, null, 'SYNTHETIC EMPLOYER']);
    // the stub balances only when every other deduction sums into one field
    if (kind === 'pay_stub') assert.match(content[2]!.text!, /otherDeductionsCents: the sum of every deduction and tax without its own field.*Gross minus all deductions plus otherPayCents must equal netCents/s);
    if (r.kind === 'tax_return') assert.deepEqual([r.draft.refundCents, r.draft.agiCents], [-5000, null]);
  }
});

test('no tool call, the wrong tool or a non-object input is INVALID_OUTPUT; credit errors keep their code', async () => {
  const code = async (f: typeof fetch) => { try { await makeReader(f).reader.read('pay_stub', [JPEG]); } catch (e) { return (e as ReaderError).code; } };
  assert.equal(await code(reply([{ type: 'text', text: 'no' }])), 'INVALID_OUTPUT');
  assert.equal(await code(reply([{ type: 'tool_use', name: 'record_offer', input: {} }])), 'INVALID_OUTPUT');
  assert.equal(await code(reply([{ type: 'tool_use', name: 'record_pay_stub', input: 'x' }])), 'INVALID_OUTPUT');
  // an answer that isn't JSON is a transport fault (502), not an unreadable document (422)
  assert.equal(await code(async () => new Response('<html>', { status: 200 })), 'BAD_REPLY');
  assert.equal(await code(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 })), 'AI_CREDITS_EXHAUSTED');
});
