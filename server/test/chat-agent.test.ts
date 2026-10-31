import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, MAX_ROUNDS, type ChatEvent } from '../src/chat/agent.ts';
import { addUserMessage, createChat, dropFailedTail, getChat, replay, saveAssistant, startAssistant } from '../src/chat/store.ts';
import { runTool } from '../src/chat/tools.ts';
import { costCents } from '../src/chat/anthropic.ts';
import { FakeClaude, end, start, text, tool, type Ev } from './fake-claude.ts';
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
const lastMessage = (body: Record<string, unknown>) => (body.messages as { role: string; content: unknown }[]).at(-1)!;

test('plain answer streams text and saves done', async () => {
  const s = setup([[start(), ...text(0, 'You spent ', '$12.34.'), ...end('end_turn')]]);
  await s.run();
  assert.deepEqual(s.fake.requests[0]!.messages, [{ role: 'user', content: 'How much did I spend?' }]);
  const cost = costCents('fake-chat-model', { input_tokens: 1000, output_tokens: 50 });
  assert.deepEqual(s.events, [{ type: 'text', text: 'You spent ' }, { type: 'text', text: '$12.34.' }, { type: 'done', messageId: s.assistantId, costCents: cost }]);
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
  assert.deepEqual(s.events[1], { type: 'tool', name: 'spending', label: 'Spending · 2026-03', input });
  assert.equal(s.fake.requests.length, 2);
  assert.deepEqual((s.fake.requests[1]!.messages as unknown[])[0], { role: 'user', content: 'How much did I spend?' });
  const last = lastMessage(s.fake.requests[1]!);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'tu1', content: runTool(s.deps, 'spending', input).content, is_error: false }]);
  const turn = JSON.parse(s.db.prepare('SELECT content_json FROM chat_messages WHERE id = ?').pluck().get(s.assistantId) as string);
  assert.equal(turn.length, 3);
  const msg = getChat(s.db, s.chatId)!.messages[1]!;
  assert.deepEqual(msg.tools, [{ name: 'spending', input }]);
  assert.equal(msg.text, 'Checking.Done.');
  assert.equal((s.events.at(-1) as { costCents: number }).costCents, 2 * costCents('fake-chat-model', { input_tokens: 1000, output_tokens: 50 }));
});

test('round cap', async () => {
  const rounds = Array.from({ length: MAX_ROUNDS + 2 }, (_, r) => [start(), ...tool(0, `tu${r}`, 'categories', {}), ...end('tool_use')]);
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
  assert.deepEqual(replay(s.db, s.chatId), [{ role: 'user', content: 'Try again' }]);
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
    { role: 'user', content: 'How much did I spend?' },
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
  assert.deepEqual(msgs[2], { role: 'user', content: 'Third' });

  // a user row with no answer (say the server died before starting one) merges with the next question
  const s2 = setup([]);
  s2.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(s2.assistantId);
  addUserMessage(s2.db, s2.chatId, 'c2', 'Next', NOW);
  assert.deepEqual(replay(s2.db, s2.chatId), [{ role: 'user', content: 'How much did I spend?\n\nNext' }]);
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
    { role: 'user', content: 'How much did I spend?' },
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

test('system prompt and last tool carry cache_control', async () => {
  const s = setup([[start(), ...text(0, 'Hi'), ...end('end_turn')]]);
  await s.run();
  const body = s.fake.requests[0]!;
  const system = body.system as { text: string; cache_control?: unknown }[];
  assert.deepEqual(system[0]!.cache_control, { type: 'ephemeral' });
  assert.match(system[0]!.text, /Today is 2026-03-15/);
  const tools = body.tools as { cache_control?: unknown }[];
  assert.deepEqual(tools.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.equal(tools.filter((t) => t.cache_control).length, 1);
  assert.equal(body.model, 'fake-chat-model');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 4096);
});
