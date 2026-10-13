import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicReader } from '../src/receipt-reader/anthropic.ts';
import { ReaderError } from '../src/receipt-reader.ts';
import { loadConfig } from '../src/config.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const toolReply = (input: unknown, status = 200) => async () =>
  new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_receipt', input }], usage: { input_tokens: 1, output_tokens: 2 } }), { status });

test('sends the photo with the tool, without forcing it, and returns the validated result', async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const reader = createAnthropicReader('synthetic-key', 'claude-sonnet-5-5', async (url, init) => {
    sent = { url: String(url), init: init! };
    return toolReply({ items: [{ name: ' Synthetic Bread ', amountCents: 350 }, { name: 'Free Bag', amountCents: 0 }], taxCents: 20, tipCents: 0, feesCents: 0, totalCents: 370 })();
  });
  const r = await reader.read(JPEG);
  assert.deepEqual(r, { items: [{ name: 'Synthetic Bread', amountCents: 350 }], taxCents: 20, tipCents: 0, feesCents: 0, totalCents: 370, model: 'claude-sonnet-5-5' });
  assert.equal(sent!.url, 'https://api.anthropic.com/v1/messages');
  const headers = sent!.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'synthetic-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(String(sent!.init.body)) as { model: string; tool_choice: unknown; messages: { content: { type: string; source?: { data: string; media_type: string } }[] }[] };
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.tool_choice, undefined);
  const image = body.messages[0]!.content.find((c) => c.type === 'image')!;
  assert.equal(image.source!.media_type, 'image/jpeg');
  assert.equal(image.source!.data, JPEG.toString('base64'));
  assert.ok(sent!.init.signal);
  assert.equal((body as unknown as { max_tokens: number }).max_tokens, 8192);
});

test('a non-2xx answer, a missing tool call, invalid input or a network failure is a ReaderError', async () => {
  const bad = [
    toolReply({ items: [] , taxCents: 0, tipCents: 0, feesCents: 0, totalCents: null }),
    toolReply({ items: [{ name: 'X', amountCents: 1.5 }], taxCents: 0, tipCents: 0, feesCents: 0, totalCents: null }),
    toolReply({ items: [{ name: 'X', amountCents: 100 }], taxCents: -1, tipCents: 0, feesCents: 0, totalCents: null }),
    toolReply({}, 529),
    async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'no' }] }), { status: 200 }),
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('null', { status: 200 }),
    async () => new Response(JSON.stringify({ content: 'no' }), { status: 200 }),
  ];
  for (const f of bad) await assert.rejects(createAnthropicReader('k', 'm', f).read(JPEG), ReaderError);
});

test('a timeout is TIMEOUT; other fetch failures are UNREACHABLE; a null body is INVALID_OUTPUT', async () => {
  const code = async (f: () => Promise<Response>) => {
    try { await createAnthropicReader('k', 'm', f).read(JPEG); } catch (e) { return (e as ReaderError).code; }
  };
  assert.equal(await code(async () => { throw new DOMException('timed out', 'TimeoutError'); }), 'TIMEOUT');
  assert.equal(await code(async () => { throw new TypeError('fetch failed'); }), 'UNREACHABLE');
  assert.equal(await code(async () => new Response('null', { status: 200 })), 'INVALID_OUTPUT');
});

const base = { HERMES_API_TOKEN: 'x'.repeat(32), HERMES_TOKEN_KEY: Buffer.alloc(32).toString('base64'), HERMES_DB_PATH: '/tmp/x.db', PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b' };

test('config: the key turns reading on; the model defaults to Sonnet 5.5', () => {
  assert.equal(loadConfig(base).anthropicApiKey, null);
  assert.equal(loadConfig(base).anthropicModel, 'claude-sonnet-5-5');
  const c = loadConfig({ ...base, ANTHROPIC_API_KEY: ' synthetic ', ANTHROPIC_MODEL: 'claude-opus-5-5' });
  assert.equal(c.anthropicApiKey, 'synthetic');
  assert.equal(c.anthropicModel, 'claude-opus-5-5');
});
