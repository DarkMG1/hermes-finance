import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setImmediate as tick } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { addUserMessage, createChat, getChat, startAssistant } from '../src/chat/store.ts';
import { FakeClaude, end, start, text, tool, type Ev } from './fake-claude.ts';
import { AUTH, makeTestDeps } from './helpers.ts';

const NOW = '2026-03-15T12:00:00.000Z';
const answerRound = (...parts: string[]) => [start(), ...text(0, ...parts), ...end('end_turn')];
const toolRound = () => [start(), ...tool(0, 'tu1', 'categories', {}), ...end('tool_use')];

function setup(rounds: Ev[][] = []) {
  const { deps } = makeTestDeps();
  const fake = new FakeClaude(rounds);
  deps.claude = fake;
  const app = buildApp(deps);
  let n = 0;
  const create = async () => (await app.inject({ method: 'POST', url: '/v1/chats', headers: { ...AUTH, 'idempotency-key': `c${(n += 1)}` } })).json().id as string;
  const send = (chatId: string, clientId: string, t = 'How much did I spend?') =>
    app.inject({ method: 'POST', url: `/v1/chats/${chatId}/messages`, headers: AUTH, payload: { clientId, text: t } });
  return { deps, db: deps.db, fake, app, create, send };
}

const events = (payload: string) => payload.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => {
  const [ev, data] = b.split('\n');
  const e = JSON.parse(data!.slice('data: '.length)) as { type: string; [k: string]: unknown };
  assert.equal(ev, `event: ${e.type}`);
  return e;
});
const until = async (cond: () => boolean) => {
  for (let i = 0; !cond(); i++) { if (i > 100_000) throw new Error('timed out'); await tick(); }
};

test('create, list newest first, get, delete (usage rows kept)', async () => {
  const s = setup();
  const res = await s.app.inject({ method: 'POST', url: '/v1/chats', headers: { ...AUTH, 'idempotency-key': 'k1' } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { id: res.json().id, title: '', createdAt: NOW, updatedAt: NOW });
  s.deps.now = () => new Date('2026-03-15T13:00:00Z');
  const second = await s.create();
  assert.deepEqual((await s.app.inject({ method: 'GET', url: '/v1/chats', headers: AUTH })).json().chats.map((c: { id: string }) => c.id), [second, res.json().id]);
  const got = await s.app.inject({ method: 'GET', url: `/v1/chats/${second}`, headers: AUTH });
  assert.deepEqual(got.json().messages, []);
  s.db.prepare("INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars) VALUES ('x', '2026-03', 'main', 'chat', 'm', 1, 1, 0, 0, 50000)").run();
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/v1/chats/${second}`, headers: AUTH })).statusCode, 204);
  assert.equal((await s.app.inject({ method: 'GET', url: `/v1/chats/${second}`, headers: AUTH })).json().code, 'NOT_FOUND');
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/v1/chats/${second}`, headers: AUTH })).statusCode, 404);
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM ai_usage').pluck().get(), 1);
});

test('chat routes need the token', async () => {
  const s = setup([answerRound('x')]);
  const id = await s.create();
  for (const [method, url] of [['GET', '/v1/chats'], ['POST', `/v1/chats/${id}/messages`], ['POST', `/v1/chats/${id}/stop`], ['GET', '/v1/ai/usage']] as const) {
    assert.equal((await s.app.inject({ method, url, payload: method === 'POST' ? { clientId: 'a', text: 'hi' } : undefined })).statusCode, 401);
  }
  assert.equal(s.fake.requests.length, 0);
});

test('send streams events in order', async () => {
  const s = setup([toolRound(), answerRound('You spent ', '$12.34.')]);
  const id = await s.create();
  const res = await s.send(id, 'a');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/event-stream/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const ev = events(res.payload);
  assert.deepEqual(ev.map((e) => e.type), ['tool', 'text', 'text', 'done']);
  assert.deepEqual(ev[0], { type: 'tool', name: 'categories', label: 'Categories', input: {} });
  const chat = getChat(s.db, id)!;
  assert.deepEqual([ev[3]!.messageId, ev[3]!.status], [chat.messages[1]!.id, 'done']);
  assert.deepEqual(chat.messages.map((m) => [m.role, m.status, m.text]), [['user', 'done', 'How much did I spend?'], ['assistant', 'done', 'You spent $12.34.']]);
  assert.equal(chat.title, 'How much did I spend?');
});

test('same clientId after done replays without calling Claude', async () => {
  const s = setup([toolRound(), answerRound('You spent ', '$12.34.')]);
  const id = await s.create();
  const first = events((await s.send(id, 'a')).payload);
  const again = events((await s.send(id, 'a')).payload);
  assert.equal(s.fake.requests.length, 2);
  assert.deepEqual(again, [first[0], { type: 'text', text: 'You spent $12.34.' }, { ...first[3]!, costCents: 0, status: 'done' }]);
  assert.equal(getChat(s.db, id)!.messages.length, 2);
});

test('same clientId after failed reruns', async () => {
  const s = setup([[], answerRound('Fine.')]);
  s.fake.fail = { round: 0, code: 'HTTP_500' };
  const id = await s.create();
  assert.deepEqual(events((await s.send(id, 'a')).payload), [{ type: 'error', code: 'HTTP_500' }]);
  assert.equal(getChat(s.db, id)!.messages[1]!.status, 'failed');
  assert.deepEqual(events((await s.send(id, 'a')).payload).map((e) => e.type), ['text', 'done']);
  assert.deepEqual(getChat(s.db, id)!.messages.map((m) => [m.role, m.status]), [['user', 'done'], ['assistant', 'done']]);
});

test('a failed answer dropped by a later send: resending its clientId asks again as a new question', async () => {
  const s = setup([[], answerRound('B.'), answerRound('A.')]);
  s.fake.fail = { round: 0, code: 'HTTP_500' };
  const id = await s.create();
  await s.send(id, 'a', 'Question A');
  await s.send(id, 'b', 'Question B');
  assert.deepEqual(events((await s.send(id, 'a', 'Question A')).payload).map((e) => e.type), ['text', 'done']);
  assert.deepEqual(getChat(s.db, id)!.messages.map((m) => [m.role, m.status, m.text]),
    [['user', 'done', 'Question B'], ['assistant', 'done', 'B.'], ['user', 'done', 'Question A'], ['assistant', 'done', 'A.']]);
});

test('an unexpected throw ends the stream with INTERNAL and a failed row', async () => {
  const s = setup();
  Object.defineProperty(s.deps.config, 'chatModel', { get() { throw new Error('boom'); } });
  const id = await s.create();
  assert.deepEqual(events((await s.send(id, 'a')).payload), [{ type: 'error', code: 'INTERNAL' }]);
  const m = getChat(s.db, id)!.messages[1]!;
  assert.deepEqual([m.status, m.errorCode], ['failed', 'INTERNAL']);
});

test('a throw after the answer was saved leaves the saved answer as it is', async () => {
  const s = setup([answerRound('Kept.')]);
  const id = await s.create();
  const stringify = JSON.stringify;
  mock.method(JSON, 'stringify', (v: unknown, ...rest: []) => {
    if ((v as { type?: string } | null)?.type === 'done') throw new Error('boom');
    return stringify(v, ...rest);
  });
  let payload: string;
  try { payload = (await s.send(id, 'a')).payload; } finally { mock.restoreAll(); }
  assert.deepEqual(events(payload).map((e) => e.type), ['text', 'error']);
  const m = getChat(s.db, id)!.messages[1]!;
  assert.deepEqual([m.status, m.text], ['done', 'Kept.']);
});

test('second send while one is streaming → 409 CHAT_BUSY', async () => {
  const s = setup([answerRound('Slow ', 'answer.')]);
  let release!: () => void;
  s.fake.hold = { event: 3, until: new Promise<void>((r) => { release = r; }) };
  const id = await s.create();
  const first = s.send(id, 'a');
  await until(() => s.fake.requests.length === 1);
  for (const busy of [await s.send(id, 'b'), await s.send(id, 'a'), await s.app.inject({ method: 'DELETE', url: `/v1/chats/${id}`, headers: AUTH })]) {
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, 'CHAT_BUSY');
  }
  release();
  assert.deepEqual(events((await first).payload).map((e) => e.type), ['text', 'text', 'done']);
  assert.equal((await s.send(id, 'b')).statusCode, 200);
});

test('clientId reused in another chat → 409 IDEMPOTENCY_KEY_REUSED', async () => {
  const s = setup([answerRound('One.')]);
  const a = await s.create();
  const b = await s.create();
  await s.send(a, 'same');
  const res = await s.send(b, 'same');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'IDEMPOTENCY_KEY_REUSED');
});

test('bad requests are JSON errors before streaming', async () => {
  const s = setup();
  const id = await s.create();
  const long = await s.send(id, 'a', 'x'.repeat(4001));
  assert.deepEqual([long.statusCode, long.json().code], [400, 'INVALID_REQUEST']);
  const missing = await s.send('missing', 'a');
  assert.deepEqual([missing.statusCode, missing.json().code], [404, 'NOT_FOUND']);
  s.deps.claude = null;
  const off = await s.send(id, 'a');
  assert.deepEqual([off.statusCode, off.json().code], [503, 'AI_NOT_CONFIGURED']);
  assert.equal(getChat(s.db, id)!.messages.length, 0);
});

test('credits exhausted → error event AI_CREDITS_EXHAUSTED and failed row', async () => {
  const s = setup();
  s.fake.fail = { round: 0, code: 'AI_CREDITS_EXHAUSTED' };
  const id = await s.create();
  assert.deepEqual(events((await s.send(id, 'a')).payload), [{ type: 'error', code: 'AI_CREDITS_EXHAUSTED' }]);
  const m = getChat(s.db, id)!.messages[1]!;
  assert.deepEqual([m.status, m.errorCode], ['failed', 'AI_CREDITS_EXHAUSTED']);
});

test('GET /v1/ai/usage sums this month only and reports backupActive, with or without a configured key', async () => {
  const s = setup();
  const usage = async () => (await s.app.inject({ method: 'GET', url: '/v1/ai/usage', headers: AUTH })).json();
  s.deps.claude = null;
  assert.deepEqual(await usage(), { month: '2026-03', costCents: 0, backupActive: false });
  const ins = s.db.prepare("INSERT INTO ai_usage (at, month, key, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microdollars) VALUES ('x', ?, 'main', 'chat', 'm', 1, 1, 0, 0, ?)");
  ins.run('2026-02', 5_000_000);
  ins.run('2026-03', 300_000);
  ins.run('2026-03', 120_000);
  s.db.prepare("INSERT INTO ai_key_state (month, backup_active) VALUES ('2026-03', 1)").run();
  assert.deepEqual(await usage(), { month: '2026-03', costCents: 42, backupActive: true });
});

test('startup marks streaming rows INTERRUPTED', () => {
  const { deps } = makeTestDeps();
  const chat = createChat(deps.db, NOW);
  addUserMessage(deps.db, chat.id, 'a', 'Hi', NOW);
  startAssistant(deps.db, chat.id, NOW);
  buildApp(deps);
  const m = getChat(deps.db, chat.id)!.messages[1]!;
  assert.deepEqual([m.status, m.errorCode], ['failed', 'INTERRUPTED']);
});

test('keepalive comment written while waiting', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const s = setup([answerRound('Late.')]);
    let release!: () => void;
    s.fake.hold = { event: 0, until: new Promise<void>((r) => { release = r; }) };
    const id = await s.create();
    const set = mock.method(globalThis, 'setInterval');
    const clear = mock.method(globalThis, 'clearInterval');
    const res = s.send(id, 'a');
    await until(() => s.fake.requests.length === 1);
    await tick();
    mock.timers.tick(15_000);
    release();
    const payload = (await res).payload;
    assert.equal(payload.match(/^: keepalive\n\n/gm)?.length, 1);
    // the keepalive interval is cleared once the stream ends
    assert.equal(clear.mock.calls.some((c) => c.arguments[0] === set.mock.calls[0]!.result), true);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

test('a client that goes away mid-answer does not stop it: the answer finishes and is saved done', async () => {
  const s = setup([answerRound('Partial ', 'and the rest.')]);
  let release!: () => void;
  s.fake.hold = { event: 3, until: new Promise<void>((r) => { release = r; }) };
  const id = await s.create();
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const { port } = s.app.server.address() as { port: number };
    await new Promise<void>((resolve, reject) => {
      const req = request({ port, method: 'POST', path: `/v1/chats/${id}/messages`, headers: { ...AUTH, 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
      req.once('error', reject);
      req.end(JSON.stringify({ clientId: 'a', text: 'Hi' }));
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(getChat(s.db, id)!.messages[1]!.status, 'streaming');
    release();
    await until(() => getChat(s.db, id)!.messages[1]!.status !== 'streaming');
    const m = getChat(s.db, id)!.messages[1]!;
    assert.deepEqual([m.status, m.text], ['done', 'Partial and the rest.']);
    const replayed = events((await s.send(id, 'a')).payload);
    assert.deepEqual(replayed.map((e) => e.type), ['text', 'done']);
  } finally {
    await s.app.close();
  }
});

test('POST /v1/chats/:id/stop stops the answer, saves it stopped and frees the chat; idle → 204; unknown → 404', async () => {
  const s = setup([answerRound('Partial ', 'never sent.'), answerRound('Next.')]);
  s.fake.hold = { event: 3, until: new Promise(() => {}) };
  const id = await s.create();
  const stop = () => s.app.inject({ method: 'POST', url: `/v1/chats/${id}/stop`, headers: AUTH });
  const first = s.send(id, 'a');
  await until(() => s.fake.requests.length === 1);
  await tick();
  assert.equal((await stop()).statusCode, 204);
  const m = getChat(s.db, id)!.messages[1]!;
  assert.deepEqual([m.status, m.text], ['stopped', 'Partial ']);
  assert.deepEqual(events((await first).payload).map((e) => e.type), ['text']);
  s.fake.hold = undefined;
  assert.deepEqual(events((await s.send(id, 'b')).payload).map((e) => e.type), ['text', 'done']);
  assert.equal((await stop()).statusCode, 204);
  const missing = await s.app.inject({ method: 'POST', url: '/v1/chats/missing/stop', headers: AUTH });
  assert.deepEqual([missing.statusCode, missing.json().code], [404, 'NOT_FOUND']);
});

test('no message text in logs', async () => {
  const s = setup([toolRound(), answerRound('SYNTHETIC ANSWER TEXT')]);
  const id = await s.create();
  const lines: string[] = [];
  const saved = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await s.send(id, 'a', 'SYNTHETIC QUESTION TEXT');
  } finally {
    [console.log, console.error, console.warn] = saved as [typeof console.log, typeof console.error, typeof console.warn];
  }
  assert.equal(lines.some((l) => l.includes('SYNTHETIC QUESTION TEXT') || l.includes('SYNTHETIC ANSWER TEXT')), false);
});
