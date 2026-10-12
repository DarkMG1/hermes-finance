import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicReader } from '../src/receipt-reader/anthropic.ts';
import { ReaderError } from '../src/receipt-reader.ts';
import { loadConfig } from '../src/config.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const toolReply = (input: unknown, status = 200) => async () =>
  new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_receipt', input }], usage: { input_tokens: 1, output_tokens: 2 } }), { status });

test('sends the photo with the forced tool and returns the validated result', async () => {
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
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'record_receipt' });
  const image = body.messages[0]!.content.find((c) => c.type === 'image')!;
  assert.equal(image.source!.media_type, 'image/jpeg');
  assert.equal(image.source!.data, JPEG.toString('base64'));
});

test('a non-2xx answer, a missing tool call, invalid input or a network failure is a ReaderError', async () => {
  const bad = [
    toolReply({ items: [] , taxCents: 0, tipCents: 0, feesCents: 0, totalCents: null }),
    toolReply({ items: [{ name: 'X', amountCents: 1.5 }], taxCents: 0, tipCents: 0, feesCents: 0, totalCents: null }),
    toolReply({ items: [{ name: 'X', amountCents: 100 }], taxCents: -1, tipCents: 0, feesCents: 0, totalCents: null }),
    toolReply({}, 529),
    async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'no' }] }), { status: 200 }),
    async () => { throw new TypeError('fetch failed'); },
  ];
  for (const f of bad) await assert.rejects(createAnthropicReader('k', 'm', f).read(JPEG), ReaderError);
});

const base = { HERMES_API_TOKEN: 'x'.repeat(32), HERMES_TOKEN_KEY: Buffer.alloc(32).toString('base64'), HERMES_DB_PATH: '/tmp/x.db', PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b' };

test('config: the key turns reading on; the model defaults to Sonnet 5.5', () => {
  assert.equal(loadConfig(base).anthropicApiKey, null);
  assert.equal(loadConfig(base).anthropicModel, 'claude-sonnet-5-5');
  const c = loadConfig({ ...base, ANTHROPIC_API_KEY: ' synthetic ', ANTHROPIC_MODEL: 'claude-opus-5-5' });
  assert.equal(c.anthropicApiKey, 'synthetic');
  assert.equal(c.anthropicModel, 'claude-opus-5-5');
});
