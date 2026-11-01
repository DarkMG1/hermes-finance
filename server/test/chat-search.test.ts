import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUserMessage, createChat, deleteChat, dropFailedTail, getChat, saveAssistant, startAssistant } from '../src/chat/store.ts';
import { RESULT_MAX, TOOLS, runTool } from '../src/chat/tools.ts';
import { toolLabel } from '../src/chat/labels.ts';
import { localDay } from '../src/days.ts';
import { makeTestDeps } from './helpers.ts';

const MARCH = '2026-03-15T12:00:00.000Z';
const APRIL = '2026-04-20T12:00:00.000Z';
const say = (...texts: string[]) => [{ role: 'assistant' as const, content: texts.map((text) => ({ type: 'text', text })) }];

function setup() {
  const { deps } = makeTestDeps();
  const db = deps.db;
  const ask = (q: string, a: string[] | null, status: 'done' | 'failed' | 'stopped' = 'done', at = MARCH, chatId = createChat(db, at).id) => {
    addUserMessage(db, chatId, `c-${Math.random()}`, q, at);
    const id = startAssistant(db, chatId, at);
    if (a) saveAssistant(db, id, say(...a), status, status === 'failed' ? 'HTTP_500' : null);
    return chatId;
  };
  const search = (input: unknown) => runTool(deps, 'search_chats', input);
  const found = (input: unknown) => JSON.parse(search(input).content).results as { chatId: string; title: string; date: string; role: string; snippet: string }[];
  return { deps, db, ask, search, found };
}

test('search_chats finds a question and its answer by stem, with title, date and snippet', () => {
  const { ask, found } = setup();
  const a = ask('Grocery spending at SYNTHETIC GROCER?', ['You spent a lot on groceries.', 'Mostly at SYNTHETIC GROCER.']);
  ask('Unrelated question about rent', ['Rent was steady.']);
  const r = found({ query: 'grocery' });
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.chatId === a && x.title === 'Grocery spending at SYNTHETIC GROCER?' && x.date === localDay(new Date(MARCH))));
  assert.deepEqual(r.map((x) => x.role).sort(), ['assistant', 'user']);
  assert.ok(r.some((x) => x.role === 'assistant' && x.snippet.includes('[groceries]')));
});

test('a failed answer is not indexed, a stopped one is, and a rerun replaces the failed pair', () => {
  const { db, ask, found } = setup();
  const chatId = ask('Question one', ['zebracorn failed text'], 'failed');
  ask('Question two', ['unicornfish stopped text'], 'stopped');
  assert.deepEqual(found({ query: 'zebracorn' }), []);
  assert.equal(found({ query: 'unicornfish' }).length, 1);
  assert.equal(found({ query: 'one' }).length, 1);
  dropFailedTail(db, chatId);
  assert.deepEqual(found({ query: 'one' }), []);
});

test('re-saving an answer replaces its index entry', () => {
  const { db, found } = setup();
  const chatId = createChat(db, MARCH).id;
  addUserMessage(db, chatId, 'c1', 'Hi', MARCH);
  const id = startAssistant(db, chatId, MARCH);
  saveAssistant(db, id, say('alphaword'), 'done', null);
  saveAssistant(db, id, say('betaword'), 'done', null);
  assert.deepEqual(found({ query: 'alphaword' }), []);
  assert.equal(found({ query: 'betaword' }).length, 1);
  saveAssistant(db, id, say('betaword'), 'failed', 'HTTP_500');
  assert.deepEqual(found({ query: 'betaword' }), []);
});

test('deleting a chat removes its results', () => {
  const { db, ask, found } = setup();
  const a = ask('dining out question', ['dining answer']);
  assert.equal(found({ query: 'dining' }).length, 2);
  deleteChat(db, a);
  assert.deepEqual(found({ query: 'dining' }), []);
});

test('punctuation and quotes never throw; a query with no terms is an error result', () => {
  const { ask, search, found } = setup();
  ask('dining out at SYNTHETIC BISTRO', ['roth-ira? maybe']);
  assert.equal(found({ query: 'dining "out"' }).length, 1);
  for (const query of ['roth-ira?', 'dining *', 'NEAR(a b)', 'a OR', 'dining "']) assert.equal(search({ query }).isError, false, query);
  assert.equal(found({ query: 'roth-ira?' }).length, 1);
  for (const query of ['', '   ', '*', '?!*', '"']) assert.equal(search({ query }).isError, true, query);
});

test('from and to filter by message date; results are newest first', () => {
  const { ask, found } = setup();
  ask('savings in march', ['ok'], 'done', MARCH);
  ask('savings in april', ['ok'], 'done', APRIL);
  assert.deepEqual(found({ query: 'savings' }).map((r) => r.date), [localDay(new Date(APRIL)), localDay(new Date(MARCH))]);
  assert.deepEqual(found({ query: 'savings', from: '2026-04-01' }).map((r) => r.date), [localDay(new Date(APRIL))]);
  assert.deepEqual(found({ query: 'savings', to: localDay(new Date(MARCH)) }).map((r) => r.date), [localDay(new Date(MARCH))]);
  assert.equal(found({ query: 'savings', limit: 1 }).length, 1);
});

test('read_chat returns the same text as getChat; unknown id is an error result', () => {
  const { deps, db, ask } = setup();
  const a = ask('First question', ['Part one.', 'Part two.']);
  const chat = getChat(db, a)!;
  const r = JSON.parse(runTool(deps, 'read_chat', { id: a }).content);
  assert.deepEqual(r, {
    id: a, title: chat.title, createdAt: chat.createdAt,
    messages: chat.messages.map((m) => ({ role: m.role, date: localDay(new Date(m.createdAt)), text: m.text })),
  });
  assert.equal(r.messages[1]!.text, 'Part one.\n\nPart two.');
  assert.equal(runTool(deps, 'read_chat', { id: 'missing' }).isError, true);
});

test('labels', () => {
  assert.equal(toolLabel('search_chats', { query: 'dining', from: '2026-03-01' }), 'Past chats · dining');
  assert.equal(toolLabel('search_chats', { query: '2026-09' }), 'Past chats · 2026-09');
  assert.equal(toolLabel('read_chat', { id: 'x' }), 'Past chat');
});

test('search_chats leaves out the conversation being answered', () => {
  const { deps, ask } = setup();
  const past = ask('emergency fund question', ['ok']);
  const current = ask('what did I say about the emergency fund?', null);
  const ids = (ctx?: { chatId: string }) => JSON.parse(runTool(deps, 'search_chats', { query: 'emergency' }, ctx).content).results.map((r: { chatId: string }) => r.chatId);
  assert.deepEqual(ids({ chatId: current }), [past]);
  assert.equal(ids().length, 2);
});

test('read_chat cuts an oversized message and keeps the newest ones', () => {
  const { deps, db, ask } = setup();
  const chatId = ask('First question', ['short answer']);
  addUserMessage(db, chatId, 'c-long', 'Tell me everything', APRIL);
  saveAssistant(db, startAssistant(db, chatId, APRIL), say('SYNTHETIC '.repeat(2500)), 'done', null);
  const c = runTool(deps, 'read_chat', { id: chatId }).content;
  assert.ok(c.length <= RESULT_MAX);
  const r = JSON.parse(c);
  assert.equal(r.messages.at(-1).role, 'assistant');
  assert.match(r.messages.at(-1).text, /^SYNTHETIC .*… \[message cut\]$/);
  assert.equal(r.messages.at(-2).text, 'Tell me everything');
  for (let i = 0; i < 3; i++) {
    addUserMessage(db, chatId, `c-more${i}`, 'Another', APRIL);
    saveAssistant(db, startAssistant(db, chatId, APRIL), say('SYNTHETIC '.repeat(2500)), 'done', null);
  }
  const cut = JSON.parse(runTool(deps, 'read_chat', { id: chatId }).content);
  assert.equal(cut.note, 'Oldest messages left out.');
  assert.ok(cut.messages.length >= 1 && cut.messages.length < 10);
  assert.equal(cut.messages.at(-1).role, 'assistant');
});

test('past-chat tool descriptions say nothing about cents', () => {
  for (const t of TOOLS) assert.equal(/integer cents/.test(t.description), !['search_chats', 'read_chat'].includes(t.name), t.name);
});

test('search_chats without query lists recent chats newest first with their first question, leaving out the current one and empty chats', () => {
  const { deps, db, ask } = setup();
  const march = ask('What did I spend on SYNTHETIC GROCER?', ['A lot.'], 'done', MARCH);
  const april = ask(`Plan my savings ${'x'.repeat(300)}`, ['Save more.'], 'done', APRIL);
  addUserMessage(db, april, 'c-later', 'A follow-up', APRIL);
  createChat(db, APRIL);
  const current = ask('summarize our previous chat', null, 'done', APRIL);
  const recent = (input: Record<string, unknown>, ctx?: { chatId: string }) => JSON.parse(runTool(deps, 'search_chats', input, ctx).content).results;
  const all = recent({}, { chatId: current });
  assert.deepEqual(all.map((r: { chatId: string }) => r.chatId), [april, march]);
  assert.deepEqual(all[1], { chatId: march, title: 'What did I spend on SYNTHETIC GROCER?', date: localDay(new Date(MARCH)), snippet: 'What did I spend on SYNTHETIC GROCER?' });
  assert.equal(all[0].snippet, `Plan my savings ${'x'.repeat(184)}…`);
  assert.deepEqual(recent({ limit: 1 }, { chatId: current }).map((r: { chatId: string }) => r.chatId), [april]);
  assert.deepEqual(recent({ to: localDay(new Date(MARCH)) }).map((r: { chatId: string }) => r.chatId), [march]);
  // a March chat followed up in April is dated and filtered by its first question
  addUserMessage(db, march, 'c-april', 'And in April?', APRIL);
  assert.equal(recent({}, { chatId: current }).find((r: { chatId: string }) => r.chatId === march).date, localDay(new Date(MARCH)));
  assert.deepEqual(recent({ to: localDay(new Date(MARCH)) }).map((r: { chatId: string }) => r.chatId), [march]);
  assert.deepEqual(recent({ from: localDay(new Date(APRIL)) }, { chatId: current }).map((r: { chatId: string }) => r.chatId), [april]);
  assert.equal(toolLabel('search_chats', {}), 'Past chats');
});
