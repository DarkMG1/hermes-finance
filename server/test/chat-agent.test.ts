import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, MAX_ANSWER_MICROS, MAX_PAUSES, MAX_ROUNDS, type ChatEvent } from '../src/chat/agent.ts';
import { addUserMessage, createChat, dropFailedTail, getChat, LOCKED_NOTE, replay, saveAssistant, startAssistant } from '../src/chat/store.ts';
import { PROFILE_TOOLS } from '../src/chat/labels.ts';
import { runTool } from '../src/chat/tools.ts';
import { toolLabel } from '../src/chat/labels.ts';
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

test('an empty or blank text block is never sent back, on the next round or on replay', async () => {
  for (const parts of [[], ['\n\n', ' ']]) {
    const s = setup([
      [start(), ...text(0, ...parts), ...tool(1, 'tu1', 'spending', { period: 'month', date: '2026-03' }), ...end('tool_use')],
      [start(), ...text(0, 'Done.'), ...end('end_turn')],
    ]);
    await s.run();
    assert.equal(s.fake.requests.length, 2);
    assert.deepEqual((bare(s.fake.requests[1]!.messages as Msg[]).at(-2)!.content as { type: string }[]).map((b) => b.type), ['tool_use']);
    assert.equal(s.events.at(-1)!.type, 'done');
  }
  // a blank block stored by an older build stays out of the replay too
  const { deps } = makeTestDeps();
  const chat = createChat(deps.db, NOW);
  addUserMessage(deps.db, chat.id, 'c1', 'Q', NOW);
  saveAssistant(deps.db, startAssistant(deps.db, chat.id, NOW), [{ role: 'assistant', content: [{ type: 'text', text: '\n\n' }, { type: 'text', text: 'A.' }] }], 'done', null);
  assert.deepEqual(replay(deps.db, chat.id)[1]!.content, [{ type: 'text', text: 'A.' }]);
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
  assert.equal(getChat(db, chatId)!.title, '');
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
const titled = (title: string, stop_reason = 'end_turn') => ({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: title }], stop_reason,
  usage: { input_tokens: 80, output_tokens: 6 } });

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
  // only fields the Haiku 5.5 docs list (effort: all five levels on Haiku 5.5)
  assert.deepEqual(Object.keys(call!.body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  // the title model gets no thinking binding and no beta
  assert.equal(call!.body.thinking, undefined);
  assert.equal(call!.body.betas, undefined);
  assert.deepEqual(call!.body.output_config, { effort: 'low' });
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

test('a failed title call, an empty title, a max_tokens reply or a stopped first answer keeps the first-question title', async () => {
  for (const reply of [new Error('boom'), new ClaudeError('HTTP_500'), { content: [] }, titled('  "." '), titled('Cut short', 'max_tokens')]) {
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

test('a later question also marks the question before the last answer, in every round; four breakpoints at most, none stored', async () => {
  const s = setup([
    [start(), ...tool(0, 'tu1', 'categories', {}), ...end('tool_use')],
    [start(), ...text(0, 'First.'), ...end('end_turn')],
    [start(), ...tool(0, 'tu2', 'categories', {}), ...end('tool_use')],
    [start(), ...text(0, 'Second.'), ...end('end_turn')],
  ]);
  await s.run();
  addUserMessage(s.db, s.chatId, 'c2', 'And now?', NOW);
  await answer(s.deps, s.chatId, startAssistant(s.db, s.chatId, NOW), () => {}, new AbortController().signal);
  const marked = (body: Record<string, unknown>) => (body.messages as { content: { cache_control?: unknown }[] }[])
    .flatMap((m, i) => m.content.map((b, j) => (b.cache_control ? `${i}.${j}` : ''))).filter(Boolean);
  // round 1 of the first answer: only the newest block (the question is not before a stored answer)
  assert.deepEqual(marked(s.fake.requests[1]!), ['2.0']);
  // the second answer: question 1 (where the first answer's round 0 cached) and the newest block
  assert.deepEqual(marked(s.fake.requests[2]!), ['0.1', '4.1']);
  assert.deepEqual(marked(s.fake.requests[3]!), ['0.1', '6.0']);
  for (const body of s.fake.requests) assert.ok(JSON.stringify(body).match(/"cache_control"/g)!.length <= 4);
  assert.ok(!JSON.stringify(replay(s.db, s.chatId)).includes('cache_control'));
});

test('system prompt, last tool and the newest message block carry cache_control; the system prompt has no date', async () => {
  const s = setup([[start(), ...text(0, 'Hi'), ...end('end_turn')]]);
  await s.run();
  const body = s.fake.requests[0]!;
  const system = body.system as { text: string; cache_control?: unknown }[];
  assert.deepEqual(system[0]!.cache_control, { type: 'ephemeral' });
  assert.doesNotMatch(system[0]!.text, /\d{4}-\d{2}-\d{2}/);
  assert.match(system[0]!.text, /never compute tax yourself\. Never recommend a sale the what-if marks blocked; say what's missing\./);
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
  assert.equal(body.max_tokens, 64_000);
  // a replayed thinking block that no longer matches is dropped, not a failed answer
  assert.deepEqual(body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(body.betas, ['thinking-binding-controls-2026-08-01']);
});

test('a first answer stopped (with or without text) leaves the auto title, so the next done answer names the chat', async () => {
  for (const partial of [[], [...text(0, 'You spent ')]]) {
    const s = setup([[start(), ...partial, ...text(1, 'more'), ...end('end_turn')], [start(), ...text(0, 'Dining was $45.'), ...end('end_turn')]]);
    s.fake.reply = titled('Dining this month');
    const ctl = new AbortController();
    s.fake.hold = { event: partial.length + 1, until: new Promise(() => {}) };
    const running = s.run(ctl.signal);
    await settle();
    ctl.abort();
    await running;
    s.fake.hold = undefined;
    assert.equal(getChat(s.db, s.chatId)!.messages[1]!.status, 'stopped');
    addUserMessage(s.db, s.chatId, 'c2', 'What about dining?', NOW);
    await answer(s.deps, s.chatId, startAssistant(s.db, s.chatId, NOW), () => {}, new AbortController().signal);
    await settle();
    assert.equal(getChat(s.db, s.chatId)!.title, 'Dining this month');
    assert.match(JSON.stringify(s.fake.messageRequests[0]!.body.messages), /Question: What about dining\?/);
  }
});

test('a failed first answer replaced by a reworded question titles the chat from the new one', async () => {
  const s = setup([[start(), ...text(0, 'Rent was $900.'), ...end('end_turn')]], 'Waht is rnet?');
  saveAssistant(s.db, s.assistantId, [], 'failed', 'HTTP_500');
  dropFailedTail(s.db, s.chatId);
  addUserMessage(s.db, s.chatId, 'c2', 'What is rent?', NOW);
  assert.equal(getChat(s.db, s.chatId)!.title, 'What is rent?');
  s.fake.reply = titled('Monthly rent');
  await answer(s.deps, s.chatId, startAssistant(s.db, s.chatId, NOW), () => {}, new AbortController().signal);
  await settle();
  assert.equal(getChat(s.db, s.chatId)!.title, 'Monthly rent');
});

test('a title that is not the auto title is never replaced, and makes no title call', async () => {
  const s = setup([[start(), ...text(0, 'Hi.'), ...end('end_turn')]]);
  s.db.prepare('UPDATE chat_conversations SET title = ? WHERE id = ?').run('Owner title', s.chatId);
  s.fake.reply = titled('Some title');
  await s.run();
  await settle();
  assert.equal(s.fake.messageRequests.length, 0);
  assert.equal(getChat(s.db, s.chatId)!.title, 'Owner title');
});

const chart = (title: string) => ({ kind: 'bar', title, unit: 'count', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] });

test('a third chart in one answer is refused; refused charts emit no tool event and getChat leaves them out', async () => {
  const s = setup([
    [start(), ...tool(0, 'c1', 'show_chart', chart('One')), ...tool(1, 'c2', 'show_chart', { ...chart('Bad'), kind: 'pie' }), ...end('tool_use')],
    [start(), ...tool(0, 'c3', 'show_chart', chart('Two')), ...tool(1, 'c4', 'show_chart', chart('Three')), ...end('tool_use')],
    [start(), ...text(0, 'Done.'), ...end('end_turn')],
  ]);
  await s.run();
  const results = (s.fake.requests[2]!.messages as Msg[]).flatMap((m) => (Array.isArray(m.content) ? m.content : []) as { type: string; tool_use_id?: string; content?: string; is_error?: boolean }[])
    .filter((b) => b.type === 'tool_result');
  assert.deepEqual(results.map((b) => [b.tool_use_id, b.is_error]), [['c1', false], ['c2', true], ['c3', false], ['c4', true]]);
  assert.match(results[3]!.content!, /at most 2 charts per answer/);
  const shown = s.events.filter((e) => e.type === 'tool').map((e) => (e as { label: string }).label);
  assert.deepEqual(shown, ['Chart · One', 'Chart · Two']);
  assert.deepEqual(getChat(s.db, s.chatId)!.messages[1]!.tools.map((t) => t.label), shown);
});

test('a title call that keeps failing is tried for the first 3 done answers only', async () => {
  const s = setup([1, 2, 3, 4].map((n) => [start(), ...text(0, `Answer ${n}.`), ...end('end_turn')]));
  s.fake.reply = new ClaudeError('HTTP_500');
  await s.run();
  for (const n of [2, 3, 4]) {
    addUserMessage(s.db, s.chatId, `c${n}`, `Question ${n}`, NOW);
    await answer(s.deps, s.chatId, startAssistant(s.db, s.chatId, NOW), () => {}, new AbortController().signal);
    await settle();
  }
  assert.equal(s.fake.messageRequests.length, 3);
  assert.equal(getChat(s.db, s.chatId)!.title, 'How much did I spend?');
});

const search = (i: number, id: string, query: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } },
  { type: 'content_block_stop', index: i },
  { type: 'content_block_start', index: i + 1, content_block: { type: 'web_search_tool_result', tool_use_id: id,
    content: [{ type: 'web_search_result', url: 'https://example.com/limits', title: 'Limits', encrypted_content: 'enc' }] } },
  { type: 'content_block_stop', index: i + 1 },
];
const searched = (searches: number): Ev[] => [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50, server_tool_use: { web_search_requests: searches } } },
  { type: 'message_stop' }];

test('a web search runs on the server: its line shows, its blocks and the cited text are kept for replay, and it costs a cent', async () => {
  const cited = { type: 'web_search_result_location', url: 'https://example.com/limits', cited_text: 'The limit is $7,500.' };
  const s = setup([[start(), ...search(0, 'srv1', '2026 IRA limit'),
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'It is $7,500.' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: cited } },
    { type: 'content_block_stop', index: 2 }, ...searched(1)]], 'What is the 2026 IRA limit?');
  await s.run();
  const tools = s.fake.requests[0]!.tools as { name: string; type?: string; max_uses?: number }[];
  assert.deepEqual(tools[0], { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  assert.match(JSON.stringify(s.fake.requests[0]!.system), /never put the owner's names, employers, amounts/);
  assert.deepEqual(s.events.filter((e) => e.type === 'tool'), [{ type: 'tool', name: 'web_search', label: 'Web search · 2026 IRA limit', input: { query: '2026 IRA limit' } }]);
  const done = s.events.at(-1) as { costCents: number };
  assert.equal(done.costCents, toCents(costMicros('fake-chat-model', { input_tokens: 1000, output_tokens: 50 }) + 10_000));
  assert.deepEqual(getChat(s.db, s.chatId)!.messages[1]!.tools, [{ name: 'web_search', input: { query: '2026 IRA limit' }, label: 'Web search · 2026 IRA limit' }]);
  const replayed = replay(s.db, s.chatId).at(-1)!.content as { type: string; citations?: unknown[] }[];
  assert.deepEqual(replayed.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'text']);
  assert.deepEqual(replayed[2]!.citations, [cited]);
});

test('a paused search resumes with the answer so far as the last message, and both parts save as one answer', async () => {
  const s = setup([[start(), ...search(0, 'srv1', 'California 2026 brackets'), ...end('pause_turn')],
    [start(), ...text(0, 'Here they are.'), ...end('end_turn')]]);
  await s.run();
  assert.equal(s.fake.requests.length, 2);
  const resumed = lastMessage(s.fake.requests[1]!) as { role: string; content: { type: string }[] };
  assert.deepEqual([resumed.role, resumed.content.map((b) => b.type)], ['assistant', ['server_tool_use', 'web_search_tool_result']]);
  const turn = JSON.parse(s.db.prepare('SELECT content_json FROM chat_messages WHERE id = ?').pluck().get(s.assistantId) as string) as { role: string; content: { type: string }[] }[];
  assert.deepEqual(turn.map((m) => [m.role, m.content.map((b) => b.type)]), [['assistant', ['server_tool_use', 'web_search_tool_result', 'text']]]);
  assert.equal(getChat(s.db, s.chatId)!.messages[1]!.text, 'Here they are.');
});

test('document pages go to the model as images in the live answer only; the stored turn and later replays carry placeholders', async () => {
  const s = setup([
    [start(), ...tool(0, 'tu1', 'document_pages', { id: 'd1', pages: [1] }), ...end('tool_use')],
    [start(), ...tool(0, 'tu2', 'categories', {}), ...end('tool_use')],
    [start(), ...text(0, 'Done.'), ...end('end_turn')],
  ]);
  const doc = 'd1';
  s.db.prepare("INSERT INTO documents (id, kind, page_count, created_at) VALUES ('d1', 'w4', 1, ?)").run(NOW);
  s.db.prepare("INSERT INTO document_links (document_id, record_type, record_id) VALUES ('d1', 'w4', 'j1')").run();
  s.db.prepare("INSERT INTO document_pages (document_id, idx, jpeg) VALUES ('d1', 1, ?)").run(Buffer.from([0xff, 0xd8, 0x01]));
  await s.run();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0x01]).toString('base64') } };
  for (const r of [1, 2]) {
    const sent = (bare(s.fake.requests[r]!.messages as Msg[])[2]!.content as { content: unknown[] }[])[0]!.content;
    assert.deepEqual(sent.slice(1), [image], `round ${r + 1} resends the page`);
  }
  const stored = s.db.prepare('SELECT content_json FROM chat_messages WHERE id = ?').pluck().get(s.assistantId) as string;
  assert.doesNotMatch(stored, /"image"|base64/);
  const placeholder = { type: 'text', text: `[document pages shown earlier: ${doc} p.1]` };
  const result = (replay(s.db, s.chatId)[2]!.content as { type: string; content: unknown[] }[])[0]!;
  assert.equal(result.type, 'tool_result');
  assert.deepEqual(result.content.slice(1), [placeholder]);
  assert.match((result.content[0] as { text: string }).text, new RegExp(doc));
  assert.deepEqual(getChat(s.db, s.chatId)!.messages[1]!.tools.map((t) => t.label), ['Document pages', 'Categories']);
});

const seedPages = (s: ReturnType<typeof setup>, n: number) => {
  s.db.prepare("INSERT INTO documents (id, kind, page_count, created_at) VALUES ('d1', 'pay_stub', ?, ?)").run(n, NOW);
  s.db.prepare("INSERT INTO document_links (document_id, record_type, record_id) VALUES ('d1', 'pay_stub', 's1')").run();
  for (let i = 1; i <= n; i++) s.db.prepare("INSERT INTO document_pages (document_id, idx, jpeg) VALUES ('d1', ?, ?)").run(i, Buffer.from([0xff, 0xd8, i]));
};
const storedJson = (s: ReturnType<typeof setup>) => s.db.prepare('SELECT content_json FROM chat_messages WHERE id = ?').pluck().get(s.assistantId) as string;

test('an answer sees at most 8 document pages; a call past that reads nothing, is an error result naming the pages left, and gets no tool line', async () => {
  const s = setup([
    [start(), ...tool(0, 'tu1', 'document_pages', { id: 'd1', pages: [1, 2, 3] }), ...end('tool_use')],
    [start(), ...tool(0, 'tu2', 'document_pages', { id: 'd1', pages: [1, 2, 3, 4] }), ...end('tool_use')],
    // page 9 doesn't exist: a call that read pages before the cap would fail as not found instead
    [start(), ...tool(0, 'tu3', 'document_pages', { id: 'd1', pages: [4, 9] }), ...end('tool_use')],
    [start(), ...tool(0, 'tu4', 'document_pages', { id: 'd1', pages: [5] }), ...end('tool_use')],
    [start(), ...text(0, 'Done.'), ...end('end_turn')],
  ]);
  seedPages(s, 5);
  await s.run();
  const result = (r: number) => (lastMessage(s.fake.requests[r]!).content as { content: unknown; is_error: boolean }[])[0]!;
  assert.deepEqual(result(3), { type: 'tool_result', tool_use_id: 'tu3', content: JSON.stringify({ error: 'at most 8 document pages per answer; 1 left' }), is_error: true });
  assert.equal(result(4).is_error, false);
  assert.equal((result(4).content as unknown[]).length, 2);
  assert.equal(s.events.filter((e) => e.type === 'tool').length, 3, 'live: no line for the refused call');
  assert.equal(getChat(s.db, s.chatId)!.messages[1]!.tools.length, 3, 'stored: no line for it either');
});

test('a stopped or failed answer after a document_pages round stores placeholders, never the images', async () => {
  const rounds = () => [[start(), ...tool(0, 'tu1', 'document_pages', { id: 'd1' }), ...end('tool_use')], [start(), ...text(0, 'never'), ...end('end_turn')]];
  const stopped = setup(rounds());
  seedPages(stopped, 2);
  const ctl = new AbortController();
  await answer(stopped.deps, stopped.chatId, stopped.assistantId, (e) => { if (e.type === 'tool') ctl.abort(); }, ctl.signal);
  const failed = setup(rounds());
  seedPages(failed, 2);
  failed.fake.fail = { round: 1, code: 'STREAM_overloaded_error' };
  await failed.run();
  for (const [s, status] of [[stopped, 'stopped'], [failed, 'failed']] as const) {
    assert.equal(getChat(s.db, s.chatId)!.messages[1]!.status, status);
    const json = storedJson(s);
    assert.doesNotMatch(json, /"image"|base64/, status);
    assert.match(json, /document pages shown earlier: d1 p\.2/, status);
  }
});

test('the lock note names every profile tool', () => {
  for (const name of PROFILE_TOOLS) assert.match(LOCKED_NOTE, new RegExp(`\\b${name}\\b`), name);
});

test('the next round resends every block of the last one exactly as streamed: thinking, code runs and the searches they made, and tool inputs', async () => {
  const caller = { type: 'code_execution_20260120', tool_id: 'srv-code' };
  const raw = '{"note":"say \\"hi\\" \\/ caf\\u00e9\\\\n","n":1}';
  const result = { type: 'web_search_tool_result', tool_use_id: 'srv-search', caller, content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A', encrypted_content: 'enc' }] };
  const ran = { type: 'code_execution_tool_result', tool_use_id: 'srv-code', content: { type: 'encrypted_code_execution_result', encrypted_stdout: 'enc' } };
  const startOnly = (i: number, block: Record<string, unknown>): Ev[] => [{ type: 'content_block_start', index: i, content_block: block }, { type: 'content_block_stop', index: i }];
  const s = setup([[start(), ...thinking(0, '', 'sig-1'), ...text(1),
    { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', id: 'srv-code', name: 'code_execution', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"code":"print(' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '1)"}' } },
    { type: 'content_block_stop', index: 2 },
    // a search made from code arrives whole, with no deltas
    ...startOnly(3, { type: 'server_tool_use', id: 'srv-search', name: 'web_search', input: { query: 'SYNTHETIC QUERY' }, caller }),
    ...startOnly(4, result), ...startOnly(5, ran), ...thinking(6, '', 'sig-2'),
    { type: 'content_block_start', index: 7, content_block: { type: 'tool_use', id: 'tu1', name: 'categories', input: {}, caller: { type: 'direct' } } },
    { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: raw.slice(0, 9) } },
    { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: raw.slice(9) } },
    { type: 'content_block_stop', index: 7 }, ...end('tool_use')],
  [start(), ...text(0, 'Done.'), ...end('end_turn')]]);
  await s.run();
  const sent = bare(s.fake.requests[1]!.messages as Msg[]).at(-2)!;
  // the empty text block stays out: the API rejects empty text, and its thinking check skips blank text blocks
  assert.equal(JSON.stringify(sent), JSON.stringify({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'server_tool_use', id: 'srv-code', name: 'code_execution', input: { code: 'print(1)' } },
    { type: 'server_tool_use', id: 'srv-search', name: 'web_search', input: { query: 'SYNTHETIC QUERY' }, caller }, result, ran,
    { type: 'thinking', thinking: '', signature: 'sig-2' }, { type: 'tool_use', id: 'tu1', name: 'categories', input: JSON.parse(raw), caller: { type: 'direct' } }] }));
  assert.deepEqual(s.events.filter((e) => e.type === 'tool').map((e) => (e as { label: string }).label), ['Web search · SYNTHETIC QUERY', toolLabel('categories', JSON.parse(raw))]);
  // a follow-up replays the answer with the code run its search and result point back at
  addUserMessage(s.db, s.chatId, 'c2', 'Next', NOW);
  const replayed = replay(s.db, s.chatId)[1]!.content as { type: string; id?: string }[];
  assert.deepEqual(replayed.map((b) => b.id ?? b.type), ['srv-code', 'srv-search', 'web_search_tool_result', 'code_execution_tool_result', 'tu1']);
});

test('a stored answer cut before a code run finished replays without that run or the searches it made', () => {
  const { deps } = makeTestDeps();
  const chat = createChat(deps.db, NOW);
  addUserMessage(deps.db, chat.id, 'c1', 'Research it', NOW);
  const id = startAssistant(deps.db, chat.id, NOW);
  const caller = { type: 'code_execution_20260120', tool_id: 'srv-code' };
  saveAssistant(deps.db, id, [{ role: 'assistant', content: [{ type: 'text', text: 'Looking.' },
    { type: 'server_tool_use', id: 'srv-code', name: 'code_execution', input: { code: 'x' } },
    { type: 'server_tool_use', id: 'srv-search', name: 'web_search', input: { query: 'q' }, caller },
    { type: 'web_search_tool_result', tool_use_id: 'srv-search', caller, content: [] },
    // a plain search cut before its result
    { type: 'server_tool_use', id: 'srv-plain', name: 'web_search', input: { query: 'q' } }] }], 'stopped', null);
  addUserMessage(deps.db, chat.id, 'c2', 'Next', NOW);
  assert.deepEqual((replay(deps.db, chat.id)[1]!.content as { type: string }[]).map((b) => b.type), ['text']);
});

test('resumed searches (pause_turn) have their own cap and leave the tool rounds and the last-call nudge alone', async () => {
  const paused = (r: number) => [start(), ...search(0, `srv${r}`, 'SYNTHETIC QUERY'), ...end('pause_turn')];
  const s = setup([...Array.from({ length: MAX_PAUSES }, (_, r) => paused(r)), [start(), ...tool(0, 'tu1', 'categories', {}), ...end('tool_use')],
    [start(), ...text(0, 'Done.'), ...end('end_turn')]]);
  await s.run();
  assert.equal(s.fake.requests.length, MAX_PAUSES + 2);
  for (const body of s.fake.requests) assert.equal(body.tool_choice, undefined);
  assert.equal(getChat(s.db, s.chatId)!.messages[1]!.text, 'Done.');

  // past the cap: an answer with no text failed, one with text is kept
  const over = setup(Array.from({ length: MAX_PAUSES + 3 }, (_, r) => paused(r)));
  await over.run();
  assert.equal(over.fake.requests.length, MAX_PAUSES + 1);
  assert.deepEqual(over.events.at(-1), { type: 'error', code: 'INCOMPLETE' });
  assert.equal(getChat(over.db, over.chatId)!.messages[1]!.status, 'failed');
  const said = setup([[start(), ...text(0, 'So far.'), ...search(1, 'srv0', 'SYNTHETIC QUERY'), ...end('pause_turn')],
    ...Array.from({ length: MAX_PAUSES + 2 }, (_, r) => paused(r + 1))]);
  await said.run();
  assert.equal(said.fake.requests.length, MAX_PAUSES + 1);
  assert.equal(said.events.at(-1)!.type, 'done');
  assert.equal(getChat(said.db, said.chatId)!.messages[1]!.text, 'So far.');

  // a pause on the last call resumes, still without tools
  const late = setup([...Array.from({ length: MAX_ROUNDS - 1 }, (_, r) => [start(), ...tool(0, `tu${r}`, 'categories', {}), ...end('tool_use')]),
    paused(0), [start(), ...text(0, 'Final.'), ...end('end_turn')]]);
  await late.run();
  assert.equal(late.fake.requests.length, MAX_ROUNDS + 1);
  for (const body of late.fake.requests.slice(-2)) assert.deepEqual(body.tool_choice, { type: 'none' });
  assert.equal(getChat(late.db, late.chatId)!.messages[1]!.text, 'Final.');
});

test('replayed blocks the API dropped are logged from message_start and message_delta; a tool input that is not JSON is logged', async () => {
  const dropped = [{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' }];
  const s = setup([[{ type: 'message_start', message: { usage: { input_tokens: 1000 }, input_transformations: dropped } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'categories', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"bad' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 }, input_transformations: dropped }, { type: 'message_stop' }],
  [start(), ...text(0, 'Done.'), ...end('end_turn')]]);
  const lines: string[] = [];
  const { warn } = console;
  console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { await s.run(); } finally { console.warn = warn; }
  const change = '[hermes] chat history changed: thinking_dropped/prefix_binding_mismatch at messages.1.content.0';
  assert.deepEqual(lines, [change, '[hermes] chat tool input was not JSON name=categories', change]);
});

test('an answer past the cost cap makes its next call the last one and saves what it wrote; a pause past the cap does not resume', async () => {
  // priced as Opus: $4 per million input tokens, so this round alone passes the cap
  const pricey = { type: 'message_start', message: { usage: { input_tokens: Math.ceil(MAX_ANSWER_MICROS / 4) + 1 } } };
  const s = setup([[pricey, ...tool(0, 'tu1', 'categories', {}), ...end('tool_use')], [start(), ...text(0, 'What I found.'), ...end('end_turn')]]);
  await s.run();
  assert.equal(s.fake.requests.length, 2);
  assert.equal(s.fake.requests[0]!.tool_choice, undefined);
  assert.deepEqual(s.fake.requests[1]!.tool_choice, { type: 'none' });
  assert.deepEqual((lastMessage(s.fake.requests[1]!).content as unknown[]).at(-1), { type: 'text', text: 'Answer now with what you have; no more tools.' });
  const msg = getChat(s.db, s.chatId)!.messages[1]!;
  assert.deepEqual([msg.status, msg.text], ['done', 'What I found.']);

  const p = setup([[pricey, ...text(0, 'So far.'), ...search(1, 'srv1', 'SYNTHETIC QUERY'), ...end('pause_turn')], [start(), ...text(0, 'More.'), ...end('end_turn')]]);
  await p.run();
  assert.equal(p.fake.requests.length, 1);
  assert.equal(getChat(p.db, p.chatId)!.messages[1]!.text, 'So far.');
});
