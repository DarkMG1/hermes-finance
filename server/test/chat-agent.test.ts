import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, MAX_ROUNDS, type ChatEvent } from '../src/chat/agent.ts';
import { addUserMessage, createChat, dropFailedTail, getChat, replay, saveAssistant, startAssistant } from '../src/chat/store.ts';
import { runTool } from '../src/chat/tools.ts';
import { ClaudeError, costMicros, toCents } from '../src/chat/anthropic.ts';
import { FakeClaude, end, start, text, thinking, tool, type Ev } from './fake-claude.ts';
import { makeTestDeps, seedAccount, seedTxn } from './helpers.ts';

const NOW = '2026-03-15T12:00:00.000Z';

function setup(rounds: Ev[][], question = 'How much did I spend?') {
  const { deps } = makeTestDeps();
  const fake = new FakeClaude(rounds);
  deps.claude = fake;
  const chat = createChat(deps.db, NOW);
  addUserMessage(deps.db, chat.id, 'c1', question, NOW);
  const assistantId = startAssistant(deps.db, chat.id, NOW);
  const events: ChatEvent[] = [];
  const run = (signal = new AbortController().signal) => answer(deps, chat.id, assistantId, (e) => events.push(e), signal);
  return { deps, db: deps.db, fake, chatId: chat.id, assistantId, events, run };
}
type Msg = { role: string; content: unknown };
/** A request's content without cache breakpoints, which move to the newest block on every call. */
const bare = <T>(v: T): T => JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'cache_control' ? undefined : x))) as T;
const lastMessage = (body: Record<string, unknown>) => bare(body.messages as Msg[]).at(-1)!;
const TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const q = (t: string, day = '2026-03-15') => [{ type: 'text', text: t }, { type: 'text', text: `(Asked on ${day}, ${TZ}.)` }];
const ROUND_COST = toCents(costMicros('fake-chat-model', { input_tokens: 1000, output_tokens: 50 }));

test('plain answer streams text and saves done', async () => {
  const s = setup([[start(), ...text(0, 'You spent ', '$12.34.'), ...end('end_turn')]]);
  await s.run();
  assert.deepEqual(bare(s.fake.requests[0]!.messages), [{ role: 'user', content: q('How much did I spend?') }]);
  assert.deepEqual(s.events, [{ type: 'text', text: 'You spent ' }, { type: 'text', text: '$12.34.' }, { type: 'done', messageId: s.assistantId, costCents: ROUND_COST, status: 'done' }]);
  const msg = getChat(s.db, s.chatId)!.messages[1]!;
  assert.equal(msg.text, 'You spent $12.34.');
  assert.equal(msg.status, 'done');
  assert.deepEqual(msg.tools, []);
});

test('tool round then answer', async () => {
  const input = { period: 'month', date: '2026-03' };
  const s = setup([
    [start(), ...text(0, 'Checking.'), ...tool(1, 'tu1', 'spending', input), ...end('tool_use')],
    [start(), ...text(0, 'Done.'), ...end('end_turn')],
  ]);
  seedAccount(s.db, { id: 'a1', subtype: 'checking', balanceCents: 1000 });
  seedTxn(s.db, { id: 't1', accountId: 'a1', date: '2026-03-02', amountCents: -1500, payee: 'SYNTHETIC GROCER' });
  await s.run();
  assert.deepEqual(s.events.map((e) => e.type), ['text', 'tool', 'text', 'done']);
  assert.deepEqual(s.events[1], { type: 'tool', name: 'spending', label: 'Spending · March 2026', input });
  assert.equal(s.fake.requests.length, 2);
  assert.deepEqual(bare(s.fake.requests[1]!.messages as unknown[])[0], { role: 'user', content: q('How much did I spend?') });
  const last = lastMessage(s.fake.requests[1]!);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'tu1', content: runTool(s.deps, 'spending', input).content, is_error: false }]);
  const turn = JSON.parse(s.db.prepare('SELECT content_json FROM chat_messages WHERE id = ?').pluck().get(s.assistantId) as string);
  assert.equal(turn.length, 3);
  const msg = getChat(s.db, s.chatId)!.messages[1]!;
  assert.deepEqual(msg.tools, [{ name: 'spending', input, label: 'Spending · March 2026' }]);
  // rounds join with a blank line, live and on reload alike
  assert.equal(msg.text, 'Checking.\n\nDone.');
  assert.deepEqual(s.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text), ['Checking.', '\n\nDone.']);
  assert.equal((s.events.at(-1) as { costCents: number }).costCents, toCents(2 * costMicros('fake-chat-model', { input_tokens: 1000, output_tokens: 50 })));
});

test('an empty text block is never sent back on the next round', async () => {
  const s = setup([
    [start(), ...text(0), ...tool(1, 'tu1', 'spending', { period: 'month', date: '2026-03' }), ...end('tool_use')],
    [start(), ...text(0, 'Done.'), ...end('end_turn')],
  ]);
  await s.run();
  assert.equal(s.fake.requests.length, 2);
  assert.deepEqual((bare(s.fake.requests[1]!.messages as Msg[]).at(-2)!.content as { type: string }[]).map((b) => b.type), ['tool_use']);
  assert.equal(s.events.at(-1)!.type, 'done');
});

test('round cap', async () => {
  const rounds = Array.from({ length: MAX_ROUNDS + 2 }, (_, r) => [start(), ...tool(0, `tu${r}`, 'categories', {}), ...end('tool_use')]);
  rounds[MAX_ROUNDS - 1] = [start(), ...text(0, 'Final.'), ...end('end_turn')];
  const s = setup(rounds);
  await s.run();
  assert.equal(s.fake.requests.length, MAX_ROUNDS);
  for (const body of s.fake.requests.slice(0, -1)) assert.equal(body.tool_choice, undefined);
  const tenth = s.fake.requests[MAX_ROUNDS - 1]!;
  // tools stay so the history's tool_use blocks are valid and the cache prefix holds; tool_choice none forbids new calls
  assert.ok(Array.isArray(tenth.tools));
  assert.deepEqual(tenth.tool_choice, { type: 'none' });
  const lastContent = lastMessage(tenth).content as { type: string; text?: string }[];
  assert.equal(lastContent[0]!.type, 'tool_result');
  assert.deepEqual(lastContent.at(-1), { type: 'text', text: 'Answer now with what you have; no more tools.' });
  assert.equal(s.events.at(-1)!.type, 'done');
  // every request resends the one before it unchanged, the nudge included, and the stored turn replays the last one exactly
  for (let r = 1; r < MAX_ROUNDS; r++) assertPrefix(s.fake.requests[r - 1]!, s.fake.requests[r]!);
  const stored = JSON.parse(s.db.prepare('SELECT content_json FROM chat_messages WHERE id = ?').pluck().get(s.assistantId) as string) as Msg[];
  assert.deepEqual(stored.at(-2), lastMessage(tenth));
  // the nudge is in the stored turn but never shown
  assert.equal(getChat(s.db, s.chatId)!.messages[1]!.text, 'Final.');
  addUserMessage(s.db, s.chatId, 'c2', 'Next', NOW);
  const next = replay(s.db, s.chatId);
  assert.deepEqual(next.slice(0, (tenth.messages as unknown[]).length), bare(tenth.messages));
});

function assertPrefix(before: Record<string, unknown>, after: Record<string, unknown>): void {
  assert.equal(JSON.stringify(after.system), JSON.stringify(before.system));
  assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools));
  const prev = bare(before.messages as Msg[]);
  assert.equal(JSON.stringify(bare(after.messages as Msg[]).slice(0, prev.length)), JSON.stringify(prev));
}

test('the turn being answered resends its own thinking; a later question on another day replays earlier turns without thinking', async () => {
  const s = setup([
    [start(), ...thinking(0, 'SYNTHETIC THOUGHT', 'sig-1'), ...tool(1, 'tu1', 'categories', {}), ...end('tool_use')],
    [start(), ...thinking(0, 'SYNTHETIC THOUGHT 2', 'sig-2'), ...text(1, 'First.'), ...end('end_turn')],
    [start(), ...thinking(0, 'SYNTHETIC THOUGHT 3', 'sig-3'), ...tool(1, 'tu2', 'categories', {}), ...end('tool_use')],
    [start(), ...text(0, 'Second.'), ...end('end_turn')],
  ]);
  await s.run();
  const later = '2026-03-16T12:00:00.000Z';
  s.deps.now = () => new Date(later);
  addUserMessage(s.db, s.chatId, 'c2', 'And today?', later);
  const second = startAssistant(s.db, s.chatId, later);
  await answer(s.deps, s.chatId, second, () => {}, new AbortController().signal);
  const [r0, r1, r2, r3] = s.fake.requests as Record<string, unknown>[];
  assertPrefix(r0!, r1!);
  assert.deepEqual(bare(r1!.messages as Msg[])[1]!.content,
    [{ type: 'thinking', thinking: 'SYNTHETIC THOUGHT', signature: 'sig-1' }, { type: 'tool_use', id: 'tu1', name: 'categories', input: {} }]);
  assert.equal(JSON.stringify(r2!.system), JSON.stringify(r1!.system));
  assert.equal(JSON.stringify(r2!.tools), JSON.stringify(r1!.tools));
  const msgs = bare(r2!.messages as Msg[]);
  assert.deepEqual(msgs.slice(0, 4), [
    { role: 'user', content: q('How much did I spend?') },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'categories', input: {} }] },
    bare(r1!.messages as Msg[])[2],
    { role: 'assistant', content: [{ type: 'text', text: 'First.' }] },
  ]);
  assert.deepEqual(msgs.at(-1), { role: 'user', content: q('And today?', '2026-03-16') });
  assertPrefix(r2!, r3!);
  assert.deepEqual(bare(r3!.messages as Msg[]).at(-2)!.content,
    [{ type: 'thinking', thinking: 'SYNTHETIC THOUGHT 3', signature: 'sig-3' }, { type: 'tool_use', id: 'tu2', name: 'categories', input: {} }]);
  assert.ok(!JSON.stringify(replay(s.db, s.chatId)).includes('thinking'));
});

test('stop reasons max_tokens and refusal, and a stream cut before message_stop, save failed with their codes', async () => {
  const cases: [Ev[], string][] = [
    [[start(), ...text(0, 'Long'), ...end('max_tokens')], 'MAX_TOKENS'],
    [[start(), ...text(0, 'No'), ...end('refusal')], 'REFUSED'],
    [[start(), ...text(0, 'Cut')], 'INCOMPLETE'],
  ];
  for (const [round, code] of cases) {
    const s = setup([round]);
    await s.run();
    assert.deepEqual(s.events.at(-1), { type: 'error', code });
    const m = getChat(s.db, s.chatId)!.messages[1]!;
    assert.deepEqual([m.status, m.errorCode], ['failed', code]);
  }
});

test('abort between rounds (after the tool results, before the next call) saves stopped with the finished round', async () => {
  const s = setup([[start(), ...text(0, 'Checking.'), ...tool(1, 'tu1', 'categories', {}), ...end('tool_use')], [start(), ...text(0, 'never'), ...end('end_turn')]]);
  const ctl = new AbortController();
  await answer(s.deps, s.chatId, s.assistantId, (e) => { s.events.push(e); if (e.type === 'tool') ctl.abort(); }, ctl.signal);
  assert.equal(s.fake.requests.length, 2);
  assert.deepEqual(s.events.map((e) => e.type), ['text', 'tool']);
  const m = getChat(s.db, s.chatId)!.messages[1]!;
  assert.deepEqual([m.status, m.text, m.tools.map((t) => t.name)], ['stopped', 'Checking.', ['categories']]);
});

test('getChat labels each tool and leaves out tool calls that never ran', () => {
  const { db, chatId, assistantId } = setup([]);
  const use = (id: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name: 'transactions', input });
  saveAssistant(db, assistantId, [
    { role: 'assistant', content: [use('tu1', { from: '2026-03-01' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '[]', is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Partial' }, use('tu2', {})] },
  ], 'stopped', null);
  assert.deepEqual(getChat(db, chatId)!.messages[1]!.tools, [{ name: 'transactions', input: { from: '2026-03-01' }, label: 'Transactions · Since 2026-03-01' }]);
});

test('upstream error mid-answer saves failed and emits error; replay skips the failed pair', async () => {
  const s = setup([[start(), ...text(0, 'You spent ', 'more'), ...end('end_turn')]]);
  s.fake.fail = { round: 0, event: 3, code: 'STREAM_overloaded_error' };
  await s.run();
  assert.deepEqual(s.events, [{ type: 'text', text: 'You spent ' }, { type: 'error', code: 'STREAM_overloaded_error' }]);
  const msg = getChat(s.db, s.chatId)!.messages[1]!;
  assert.equal(msg.status, 'failed');
  assert.equal(msg.errorCode, 'STREAM_overloaded_error');
  assert.equal(msg.text, '');
  assert.deepEqual(replay(s.db, s.chatId), []);
  addUserMessage(s.db, s.chatId, 'c2', 'Try again', NOW);
  assert.deepEqual(replay(s.db, s.chatId), [{ role: 'user', content: q('Try again') }]);
});

test('abort keeps partial text as stopped', async () => {
  const s = setup([[start(), ...text(0, 'You spent ', 'more', ' text'), ...end('end_turn')]]);
  const ctl = new AbortController();
  await answer(s.deps, s.chatId, s.assistantId, (e) => { s.events.push(e); ctl.abort(); }, ctl.signal);
  assert.deepEqual(s.events, [{ type: 'text', text: 'You spent ' }]);
  const msg = getChat(s.db, s.chatId)!.messages[1]!;
  assert.equal(msg.status, 'stopped');
  assert.equal(msg.text, 'You spent ');
  assert.deepEqual(replay(s.db, s.chatId).at(-1), { role: 'assistant', content: [{ type: 'text', text: 'You spent ' }] });
});

test('stopped turn with dangling tool_use replays valid', () => {
  const { db, chatId, assistantId } = setup([]);
  const use = { type: 'tool_use', id: 'tu1', name: 'accounts', input: {} };
  saveAssistant(db, assistantId, [{ role: 'assistant', content: [{ type: 'text', text: 'Let me check' }, use, { type: 'text', text: '' }] }], 'stopped', null);
  assert.deepEqual(replay(db, chatId), [
    { role: 'user', content: q('How much did I spend?') },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me check' }] },
  ]);

  addUserMessage(db, chatId, 'c2', 'And now?', NOW);
  const second = startAssistant(db, chatId, NOW);
  saveAssistant(db, second, [{ role: 'assistant', content: [use] }], 'stopped', null);
  addUserMessage(db, chatId, 'c3', 'Third', NOW);
  const third = startAssistant(db, chatId, NOW);
  saveAssistant(db, third, [{ role: 'assistant', content: [{ type: 'text', text: 'Ok' }] }], 'done', null);
  const msgs = replay(db, chatId);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(msgs[2], { role: 'user', content: q('Third') });

  // a user row with no answer (say the server died before starting one) merges with the next question
  const s2 = setup([]);
  s2.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(s2.assistantId);
  addUserMessage(s2.db, s2.chatId, 'c2', 'Next', NOW);
  assert.deepEqual(replay(s2.db, s2.chatId), [{ role: 'user', content: [...q('How much did I spend?'), ...q('Next')] }]);
});

test('stopped turn keeps completed tool rounds', () => {
  const { db, chatId, assistantId } = setup([]);
  const use = (id: string) => ({ type: 'tool_use', id, name: 'accounts', input: {} });
  saveAssistant(db, assistantId, [
    { role: 'assistant', content: [use('tu1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '[]', is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Partial' }, use('tu2')] },
  ], 'stopped', null);
  const msgs = replay(db, chatId);
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs[3], { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] });
});

test('a done turn whose last message has no text keeps its earlier text; a turn with no text at all skips the pair', () => {
  const { db, chatId, assistantId } = setup([]);
  const use = { type: 'tool_use', id: 'tu1', name: 'accounts', input: {} };
  saveAssistant(db, assistantId, [
    { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, use] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '[]', is_error: false }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
  ], 'done', null);
  assert.deepEqual(replay(db, chatId), [
    { role: 'user', content: q('How much did I spend?') },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking' }] },
  ]);
  saveAssistant(db, assistantId, [{ role: 'assistant', content: [use] }, { role: 'user', content: [] }, { role: 'assistant', content: [] }], 'done', null);
  assert.deepEqual(replay(db, chatId), []);
});

test('tool_use stop with no tool_use blocks ends the answer', async () => {
  const s = setup([[start(), ...text(0, 'Hmm.'), ...end('tool_use')], [start(), ...text(0, 'never'), ...end('end_turn')]]);
  await s.run();
  assert.equal(s.fake.requests.length, 1);
  assert.equal(s.events.at(-1)!.type, 'done');
  assert.equal(getChat(s.db, s.chatId)!.messages[1]!.text, 'Hmm.');
});

test('no Claude client saves the answer failed', async () => {
  const s = setup([]);
  s.deps.claude = null;
  await s.run();
  assert.deepEqual(s.events, [{ type: 'error', code: 'AI_NOT_CONFIGURED' }]);
  assert.equal(getChat(s.db, s.chatId)!.messages[1]!.status, 'failed');
});

test('dropFailedTail removes the failed answer and its question', () => {
  const { db, chatId, assistantId } = setup([]);
  saveAssistant(db, assistantId, [], 'failed', 'HTTP_500');
  dropFailedTail(db, chatId);
  assert.deepEqual(getChat(db, chatId)!.messages, []);
  addUserMessage(db, chatId, 'c2', 'Again', NOW);
  const a = startAssistant(db, chatId, NOW);
  saveAssistant(db, a, [{ role: 'assistant', content: [{ type: 'text', text: 'Ok' }] }], 'done', null);
  dropFailedTail(db, chatId);
  assert.equal(getChat(db, chatId)!.messages.length, 2);
});

test('title is the first message cut to 60 characters', () => {
  const long = `  ${'x'.repeat(70)}`;
  const { db, chatId } = setup([], long);
  addUserMessage(db, chatId, 'c2', 'Second question', NOW);
  assert.equal(getChat(db, chatId)!.title, 'x'.repeat(60));
});

const settle = () => new Promise((r) => setImmediate(r));
const titled = (title: string) => ({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: title }], usage: { input_tokens: 80, output_tokens: 6 } });

test('the first answer names the chat with the title model after done; later answers and a changed title are left alone', async () => {
  const s = setup([[start(), ...text(0, 'You spent $12.34 at SYNTHETIC GROCER.'), ...end('end_turn')], [start(), ...text(0, 'Ok.'), ...end('end_turn')]],
    'How much did I spend at SYNTHETIC GROCER?');
  s.fake.reply = titled(' "Grocery spending in March." \n');
  let doneTitle: string | undefined;
  await answer(s.deps, s.chatId, s.assistantId, (e) => { if (e.type === 'done') doneTitle = getChat(s.db, s.chatId)!.title; }, new AbortController().signal);
  // done goes out before the title call finishes
  assert.equal(doneTitle, 'How much did I spend at SYNTHETIC GROCER?');
  await settle();
  assert.equal(getChat(s.db, s.chatId)!.title, 'Grocery spending in March');
  const [call] = s.fake.messageRequests;
  assert.equal(call!.feature, 'chat');
  assert.equal(call!.body.model, 'fake-title-model');
  assert.match(JSON.stringify(call!.body.messages), /How much did I spend at SYNTHETIC GROCER\?.*You spent \$12\.34/);
  addUserMessage(s.db, s.chatId, 'c2', 'And then?', NOW);
  await answer(s.deps, s.chatId, startAssistant(s.db, s.chatId, NOW), () => {}, new AbortController().signal);
  await settle();
  assert.equal(s.fake.messageRequests.length, 1);

  const renamed = setup([[start(), ...text(0, 'Hi.'), ...end('end_turn')]]);
  renamed.fake.reply = titled('Some title');
  await renamed.run();
  renamed.db.prepare('UPDATE chat_conversations SET title = ? WHERE id = ?').run('Owner title', renamed.chatId);
  await settle();
  assert.equal(getChat(renamed.db, renamed.chatId)!.title, 'Owner title');
});

test('a failed title call, an empty title or a stopped first answer keeps the first-question title', async () => {
  for (const reply of [new Error('boom'), new ClaudeError('HTTP_500'), { content: [] }, titled('  "." ')]) {
    const s = setup([[start(), ...text(0, 'Hi.'), ...end('end_turn')]]);
    s.fake.reply = reply;
    await s.run();
    await settle();
    assert.equal(s.fake.messageRequests.length, 1);
    assert.equal(getChat(s.db, s.chatId)!.title, 'How much did I spend?');
    assert.equal(s.events.at(-1)!.type, 'done');
  }
  const stopped = setup([[start(), ...text(0, 'You spent ', 'more'), ...end('end_turn')]]);
  stopped.fake.reply = titled('Never');
  const ctl = new AbortController();
  await answer(stopped.deps, stopped.chatId, stopped.assistantId, () => ctl.abort(), ctl.signal);
  await settle();
  assert.equal(stopped.fake.messageRequests.length, 0);
});

test('system prompt, last tool and the newest message block carry cache_control; the system prompt has no date', async () => {
  const s = setup([[start(), ...text(0, 'Hi'), ...end('end_turn')]]);
  await s.run();
  const body = s.fake.requests[0]!;
  const system = body.system as { text: string; cache_control?: unknown }[];
  assert.deepEqual(system[0]!.cache_control, { type: 'ephemeral' });
  assert.doesNotMatch(system[0]!.text, /\d{4}-\d{2}-\d{2}/);
  const content = (body.messages as { content: { cache_control?: unknown }[] }[]).at(-1)!.content;
  assert.deepEqual(content.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.equal(JSON.stringify(body).match(/"cache_control"/g)!.length, 3);
  // the stored question carries no breakpoint
  assert.ok(!JSON.stringify(replay(s.db, s.chatId)).includes('cache_control'));
  const tools = body.tools as { cache_control?: unknown }[];
  assert.deepEqual(tools.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.equal(tools.filter((t) => t.cache_control).length, 1);
  assert.equal(body.model, 'fake-chat-model');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 16_000);
});
