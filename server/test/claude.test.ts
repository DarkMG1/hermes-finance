import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeError, costMicros, createClaude, usage as monthUsage } from '../src/chat/anthropic.ts';
import { makeTestDeps } from './helpers.ts';

const CREDIT = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 });
const OK = () => new Response(JSON.stringify({ content: [], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } }), { status: 200 });
const BODY = { model: 'claude-opus-5-5', max_tokens: 10, messages: [] };

function setup(responses: ((init: RequestInit) => Response | Promise<Response>)[], backup: string | null = 'synthetic-backup') {
  const { deps } = makeTestDeps();
  deps.config.anthropicApiKey = 'synthetic-main';
  deps.config.anthropicBackupKey = backup;
  const keys: string[] = [];
  const claude = createClaude(deps, async (_url, init) => {
    keys.push((init!.headers as Record<string, string>)['x-api-key']!);
    const next = responses.shift();
    if (!next) throw new Error('no scripted response');
    return next(init!);
  })!;
  return { deps, claude, keys, usage: () => monthUsage(deps.db, deps.now()) };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof ClaudeError ? e.code : `not ClaudeError: ${String(e)}`; } return 'resolved'; };

test('no main key: no client', () => {
  const { deps } = makeTestDeps();
  deps.config.anthropicApiKey = null;
  assert.equal(createClaude(deps), null);
});

test('main key used, usage row written with month 2026-03, key main, feature receipt, cost from costMicros', async () => {
  const s = setup([OK]);
  const r = await s.claude.messages('receipt', BODY);
  assert.equal(r.key, 'main');
  assert.deepEqual(s.keys, ['synthetic-main']);
  const row = s.deps.db.prepare('SELECT month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars FROM ai_usage').get();
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
  assert.deepEqual({ ...row as object }, { month: '2026-03', key: 'main', feature: 'receipt', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200,
    cache_read_tokens: 50, cache_write_tokens: 10, cost_microdollars: costMicros('claude-opus-5-5', usage) });
  // 4000 + 2.5 + 50 + 4000 microdollars rounds to 1 cent
  assert.deepEqual(s.usage(), { month: '2026-03', costCents: 1, backupActive: false });
});

test('credit error on main switches to backup, retries once, and stays on backup for the month', async () => {
  const s = setup([CREDIT, OK, OK]);
  assert.equal((await s.claude.messages('chat', BODY)).key, 'backup');
  assert.deepEqual(s.keys, ['synthetic-main', 'synthetic-backup']);
  assert.equal((await s.claude.messages('chat', BODY)).key, 'backup');
  assert.deepEqual(s.keys, ['synthetic-main', 'synthetic-backup', 'synthetic-backup']);
  assert.deepEqual({ ...s.deps.db.prepare('SELECT month, backup_active FROM ai_key_state').get() as object }, { month: '2026-03', backup_active: 1 });
  assert.equal(s.usage().backupActive, true);
  assert.deepEqual(s.deps.db.prepare('SELECT key FROM ai_usage ORDER BY id').pluck().all(), ['backup', 'backup']);
});

test('next month starts on main', async () => {
  const s = setup([CREDIT, OK, OK]);
  await s.claude.messages('chat', BODY);
  s.deps.now = () => new Date('2026-04-01T12:00:00Z');
  assert.equal((await s.claude.messages('chat', BODY)).key, 'main');
  assert.equal(s.keys[2], 'synthetic-main');
  assert.deepEqual(s.usage(), { month: '2026-04', costCents: 1, backupActive: false });
});

test('no backup configured or backup also out of credit is AI_CREDITS_EXHAUSTED', async () => {
  const none = setup([CREDIT], null);
  assert.equal(await code(none.claude.messages('chat', BODY)), 'AI_CREDITS_EXHAUSTED');
  // no backup in use, so nothing claims one
  assert.equal(none.usage().backupActive, false);
  assert.equal(none.deps.db.prepare('SELECT COUNT(*) FROM ai_key_state').pluck().get(), 0);
  const both = setup([CREDIT, CREDIT, CREDIT]);
  assert.equal(await code(both.claude.messages('chat', BODY)), 'AI_CREDITS_EXHAUSTED');
  assert.equal(await code(both.claude.messages('chat', BODY)), 'AI_CREDITS_EXHAUSTED');
  assert.deepEqual(both.keys, ['synthetic-main', 'synthetic-backup', 'synthetic-backup']);
});

test('other 400 / 529 / network / timeout / caller abort map to codes and never switch keys', async () => {
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), { status: 400 }), 'HTTP_400'],
    [() => new Response('{}', { status: 529 }), 'HTTP_529'],
    [() => { throw new TypeError('fetch failed'); }, 'UNREACHABLE'],
    [() => { throw new DOMException('timed out', 'TimeoutError'); }, 'TIMEOUT'],
    [() => new Response('not json', { status: 200 }), 'INVALID_OUTPUT'],
    [() => new Response('null', { status: 200 }), 'INVALID_OUTPUT'],
  ];
  for (const [f, want] of cases) {
    const s = setup([f]);
    assert.equal(await code(s.claude.messages('chat', BODY)), want);
    assert.deepEqual(s.keys, ['synthetic-main']);
    assert.equal(s.usage().backupActive, false);
  }
  const ctl = new AbortController();
  const s = setup([(init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))]);
  const p = s.claude.messages('chat', BODY, ctl.signal);
  ctl.abort();
  assert.equal(await code(p), 'ABORTED');
  assert.deepEqual(s.keys, ['synthetic-main']);
});

test('stream(): credit error before the stream starts falls back; events parse across chunk boundaries', async () => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"usa',
    'ge":{"input_tokens":10}}}\n\n: ping comment\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const body = () => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
  const s = setup([CREDIT, () => new Response(body(), { status: 200 })]);
  const { events, key } = await s.claude.stream('chat', { ...BODY, stream: true });
  assert.equal(key, 'backup');
  const got = [];
  for await (const e of events) got.push(e);
  assert.deepEqual(got.map((e) => e.type), ['message_start', 'content_block_delta', 'message_delta', 'message_stop']);
  assert.deepEqual(got[0], { type: 'message_start', message: { usage: { input_tokens: 10 } } });
  assert.deepEqual(s.keys, ['synthetic-main', 'synthetic-backup']);
  // streamed calls record once the caller knows the totals
  assert.equal(s.deps.db.prepare('SELECT COUNT(*) FROM ai_usage').pluck().get(), 0);
  assert.equal(s.claude.record('chat', 'claude-opus-5-5', key, { input_tokens: 10, output_tokens: 5 }), 140);
  assert.deepEqual({ ...s.deps.db.prepare('SELECT key, feature, input_tokens, output_tokens, cache_read_tokens FROM ai_usage').get() as object },
    { key: 'backup', feature: 'chat', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 });
});

test('stream(): an upstream error event throws STREAM_<type>', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n')); c.close(); } });
  const s = setup([() => new Response(body, { status: 200 })]);
  const { events } = await s.claude.stream('chat', BODY);
  assert.equal(await code((async () => { for await (const e of events) void e; })()), 'STREAM_overloaded_error');
});

test('costMicros: Opus $4 in / $20 out per MTok, Sonnet $2 / $10, cache reads 0.05x, writes 1.25x; unknown model priced as Opus', () => {
  assert.equal(costMicros('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24_000_000);
  assert.equal(costMicros('synthetic-model', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24_000_000);
  assert.equal(costMicros('claude-opus-5-5', { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }), 200_000 + 5_000_000);
  assert.equal(costMicros('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }),
    2_000_000 + 10_000_000 + 100_000 + 2_500_000);
  assert.equal(costMicros('claude-opus-5-5', {}), 0);
  // sub-cent calls add up: one 1000-token Sonnet input is 2000 microdollars (0.2 cent)
  assert.equal(costMicros('claude-sonnet-5-5', { input_tokens: 1000 }), 2000);
  // Haiku 5.5 (prompts up to 100k tokens): $0.10 in / $0.50 out, cache reads 0.1x
  assert.equal(costMicros('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }),
    100_000 + 500_000 + 10_000 + 125_000);
});

test('usage() sums microdollars and rounds once; it reads the rows without a configured key', () => {
  const { deps } = makeTestDeps();
  const ins = deps.db.prepare("INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars) VALUES ('x', ?, 'main', 'chat', 'm', 1, 1, 0, 0, ?)");
  for (let i = 0; i < 3; i++) ins.run('2026-03', 4000);
  ins.run('2026-02', 990_000);
  assert.deepEqual(monthUsage(deps.db, deps.now()), { month: '2026-03', costCents: 1, backupActive: false });
});

test('the monthly spend limit error also switches to the backup key', async () => {
  const limit = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-04-01 at 00:00 UTC.' } }), { status: 400 });
  const s = setup([limit, OK]);
  assert.equal((await s.claude.messages('chat', BODY)).key, 'backup');
  assert.equal(s.usage().backupActive, true);
});

test('a prompt over the context window is CHAT_TOO_LONG', async () => {
  for (const message of ['prompt is too long: 1000500 tokens > 1000000 maximum', 'input length and `max_tokens` exceed context limit: 990000 + 16000 > 1000000']) {
    const s = setup([() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400 })]);
    assert.equal(await code(s.claude.messages('chat', BODY)), 'CHAT_TOO_LONG');
    assert.deepEqual(s.keys, ['synthetic-main']);
  }
});

test('a failed call logs the error type (and the message for 4xx), never the key or the request', async () => {
  const lines: string[] = [];
  const { error } = console;
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    const s = setup([
      () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate' } }), { status: 400 }),
      () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'SYNTHETIC SERVER DETAIL' } }), { status: 500 }),
    ]);
    const body = { ...BODY, messages: [{ role: 'user', content: 'SYNTHETIC QUESTION TEXT' }] };
    await code(s.claude.messages('chat', body));
    await code(s.claude.messages('chat', body));
  } finally {
    console.error = error;
  }
  assert.deepEqual(lines, ['[hermes] claude HTTP 400 type=invalid_request_error message=messages: roles must alternate', '[hermes] claude HTTP 500 type=api_error']);
  for (const l of lines) assert.ok(!/synthetic-main|synthetic-backup|SYNTHETIC/.test(l), l);
});

test('logs never contain the key', async () => {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  console.error = console.log;
  try {
    const s = setup([CREDIT, OK, () => new Response('{}', { status: 500 })]);
    await s.claude.messages('chat', BODY);
    await code(s.claude.messages('chat', BODY));
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(!l.includes('synthetic-main') && !l.includes('synthetic-backup'), l);
});

const enc = (t: string) => new TextEncoder().encode(t);
const streamOf = (chunks: string[]) => () => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc(ch)); c.close(); } }), { status: 200 });
const types = async (events: AsyncIterable<{ type: string }>) => { const got = []; for await (const e of events) got.push(e.type); return got; };

test('stream(): CRLF line endings, split between chunks, and a last event without the blank line still parse', async () => {
  const s = setup([streamOf(['event: message_start\r\ndata: {"type":"message_start"}\r', '\n\r\ndata: {"type":"ping"}\r\n\r\n', 'data: {"type":"message_stop"}\n'])]);
  assert.deepEqual(await types((await s.claude.stream('chat', BODY)).events), ['message_start', 'ping', 'message_stop']);
});

// the scripted body emits one event after each delay, then closes; an abort errors it like a real fetch body
const timed = (delays: number[]) => (init: RequestInit) => {
  let i = 0;
  return new Response(new ReadableStream({
    start(c) { init.signal!.addEventListener('abort', () => c.error(init.signal!.reason)); },
    async pull(c) {
      if (i === delays.length) return c.close();
      await new Promise((r) => setTimeout(r, delays[i]));
      c.enqueue(enc(`data: {"type":"e${i++}"}\n\n`));
    },
  }), { status: 200 });
};
async function drive<T>(p: Promise<T>, ms: number): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let t = 0; t < ms && !done; t += 10_000) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(10_000);
  }
  return p;
}

test('stream(): the timeout is per idle gap, not on the whole answer; a stall over 120 s is TIMEOUT', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const slow = setup([timed([50_000, 50_000, 50_000, 50_000])]);
  const { events } = await slow.claude.stream('chat', BODY);
  assert.deepEqual(await drive(types(events), 400_000), ['e0', 'e1', 'e2', 'e3']);
  const stall = setup([timed([10_000, 130_000])]);
  const s2 = await stall.claude.stream('chat', BODY);
  assert.equal(await drive(code(types(s2.events)), 400_000), 'TIMEOUT');
  const ctl = new AbortController();
  const aborted = setup([timed([10_000, 130_000])]);
  const s3 = await aborted.claude.stream('chat', BODY, ctl.signal);
  const p = code(types(s3.events));
  await drive(Promise.race([p, new Promise((r) => setTimeout(r, 20_000))]), 30_000);
  ctl.abort();
  assert.equal(await p, 'ABORTED');
});

test('the request timeout covers the wait for headers: chat 120 s, receipts 60 s', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  for (const [feature, ms] of [['chat', 120_000], ['receipt', 60_000]] as const) {
    const s = setup([hang]);
    let settled = false;
    const p = code(s.claude.messages(feature, BODY)).finally(() => { settled = true; });
    await drive(new Promise((r) => setTimeout(r, ms - 10_000)), ms);
    assert.equal(settled, false);
    assert.equal(await drive(p, 30_000), 'TIMEOUT');
  }
});
