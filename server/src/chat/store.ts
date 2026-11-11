import { randomUUID } from 'node:crypto';
import type { ChatDetail, ChatList, ChatMessage, ChatSummary } from '@hermes/shared';
import type { Db } from '../db.ts';
import { addDays, localDay } from '../days.ts';
import { PROFILE_TOOLS, toolLabel } from './labels.ts';

type Block = Record<string, unknown>;
export type ApiMessage = { role: 'user' | 'assistant'; content: string | Block[] };
type Row = { id: string; seq: number; role: 'user' | 'assistant'; content_json: string; status: ChatMessage['status']; error_code: string | null; created_at: string;
  profile_locked: number };

/** A locked list or read shows this for a title written after the chat got profile data. */
export const LOCKED_TITLE = 'Locked chat';
const summary = (hideProfile: boolean) => `SELECT id, CASE WHEN ${hideProfile ? 1 : 0} AND profile_title = 1 THEN '${LOCKED_TITLE}' ELSE title END AS title,
  created_at AS createdAt, updated_at AS updatedAt FROM chat_conversations`;
const rows = (db: Db, chatId: string) =>
  db.prepare('SELECT id, seq, role, content_json, status, error_code, created_at, profile_locked FROM chat_messages WHERE conversation_id = ? ORDER BY seq').all(chatId) as Row[];
const blocks = (m: ApiMessage): Block[] => (Array.isArray(m.content) ? m.content : []);
// joined like the stream joins them, so a reload shows exactly what the stream showed
const answerText = (turn: ApiMessage[]): string =>
  turn.filter((m) => m.role === 'assistant').flatMap(blocks).filter((b) => b.type === 'text' && b.text).map((b) => b.text as string).join('\n\n');
/** An answer that got financial profile data: a profile tool call that didn't fail. */
const usedProfile = (turn: ApiMessage[]): boolean => {
  const failed = new Set(turn.filter((m) => m.role === 'user').flatMap(blocks).filter((b) => b.is_error === true).map((b) => b.tool_use_id));
  return turn.filter((m) => m.role === 'assistant').flatMap(blocks).some((b) => b.type === 'tool_use' && PROFILE_TOOLS.has(b.name as string) && !failed.has(b.id));
};
/** The chat holds profile data: some answer got it from a profile tool, or from a past chat that held it. ignoreFailedTail: as it will be once
 *  the next question drops a failed last answer. */
export function chatUsesProfile(db: Db, chatId: string, ignoreFailedTail = false): boolean {
  const from = db.prepare('SELECT profile_seq FROM chat_conversations WHERE id = ?').pluck().get(chatId) as number | null | undefined;
  const tail = ignoreFailedTail ? failedTail(db, chatId) : null;
  return from != null && (tail === null || from < tail);
}
/** Marks the chat as holding profile data from this answer on (an earlier mark stays). */
export function markProfile(db: Db, chatId: string, assistantId: string): void {
  db.prepare('UPDATE chat_conversations SET profile_seq = COALESCE(profile_seq, (SELECT seq FROM chat_messages WHERE id = ?)) WHERE id = ?').run(assistantId, chatId);
}

/** Replaces a message's search entry; no text leaves it out. Row deletes drop entries by trigger. */
function index(db: Db, id: string, text: string | null): void {
  db.prepare('DELETE FROM chat_search WHERE message_id = ?').run(id);
  if (text) db.prepare('INSERT INTO chat_search (text, message_id, conversation_id) SELECT ?, id, conversation_id FROM chat_messages WHERE id = ?').run(text, id);
}

export function createChat(db: Db, nowIso: string): ChatSummary {
  const id = randomUUID();
  db.prepare('INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, \'\', ?, ?)').run(id, nowIso, nowIso);
  return { id, title: '', createdAt: nowIso, updatedAt: nowIso };
}

export function listChats(db: Db, hideProfile = false): ChatList {
  return { chats: db.prepare(`${summary(hideProfile)} ORDER BY updated_at DESC, created_at DESC`).all() as ChatSummary[] };
}

/** hideProfile: every answer from the first one that got profile data on (a later one can repeat it) comes without its text and tools,
 *  marked profileLocked; questions stay. */
export function getChat(db: Db, id: string, hideProfile = false): ChatDetail | null {
  const chat = db.prepare(`${summary(hideProfile)} WHERE id = ?`).get(id) as ChatSummary | undefined;
  if (!chat) return null;
  const from = hideProfile ? db.prepare('SELECT profile_seq FROM chat_conversations WHERE id = ?').pluck().get(id) as number | null : null;
  const messages = rows(db, id).map((r): ChatMessage => {
    const base = { id: r.id, role: r.role, status: r.status, errorCode: r.error_code, createdAt: r.created_at };
    if (r.role === 'user') return { ...base, text: JSON.parse(r.content_json) as string, tools: [] };
    if (from !== null && r.seq >= from) return { ...base, text: '', tools: [], profileLocked: true };
    const turn = JSON.parse(r.content_json) as ApiMessage[];
    const all = turn.filter((m) => m.role === 'assistant').flatMap(blocks);
    const results = new Map(turn.filter((m) => m.role === 'user').flatMap(blocks).map((b) => [b.tool_use_id, b.is_error === true]));
    const text = answerText(turn);
    // a rejected chart showed nothing
    // a web search runs on Anthropic's side: its result is a block in the answer, not a tool_result
    const searched = new Set(all.filter((b) => b.type === 'web_search_tool_result').map((b) => b.tool_use_id));
    const tools = all.filter((b) => (b.type === 'tool_use' && results.has(b.id) && !(b.name === 'show_chart' && results.get(b.id)))
      || (b.type === 'server_tool_use' && b.name === 'web_search' && searched.has(b.id))).map((b) => {
      const input = b.input as Record<string, unknown>;
      return { name: b.name as string, input, label: toolLabel(b.name as string, input) };
    });
    return { ...base, text, tools };
  });
  return { ...chat, messages };
}

/** The automatic title only replaces the first question's, so it never overwrites this; typed by the owner, it isn't profile data. */
export function renameChat(db: Db, id: string, title: string): boolean {
  return db.prepare('UPDATE chat_conversations SET title = ?, profile_title = 0 WHERE id = ?').run(title, id).changes > 0;
}

export function deleteChat(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id).changes > 0;
}

export function findByClientId(db: Db, clientId: string): { userId: string; chatId: string; assistant: { id: string; status: string } | null } | null {
  const user = db.prepare('SELECT id, conversation_id, seq FROM chat_messages WHERE client_id = ?').get(clientId) as { id: string; conversation_id: string; seq: number } | undefined;
  if (!user) return null;
  const assistant = db.prepare('SELECT id, status FROM chat_messages WHERE conversation_id = ? AND seq = ? AND role = \'assistant\'')
    .get(user.conversation_id, user.seq + 1) as { id: string; status: string } | undefined;
  return { userId: user.id, chatId: user.conversation_id, assistant: assistant ?? null };
}

function insert(db: Db, chatId: string, role: Row['role'], clientId: string | null, content: unknown, status: Row['status'], nowIso: string): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO chat_messages (id, conversation_id, seq, role, client_id, content_json, status, created_at)
    VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE conversation_id = ?), ?, ?, ?, ?, ?)`)
    .run(id, chatId, chatId, role, clientId, JSON.stringify(content), status, nowIso);
  return id;
}

/** profileLocked: asked without the financial profile unlocked, so its answer can't use the profile tools. */
export function addUserMessage(db: Db, chatId: string, clientId: string, text: string, nowIso: string, profileLocked = false): string {
  return db.transaction(() => {
    db.prepare('UPDATE chat_conversations SET updated_at = ?, title = CASE WHEN title = \'\' THEN ? ELSE title END WHERE id = ?')
      .run(nowIso, text.trim().slice(0, 60), chatId);
    const id = insert(db, chatId, 'user', clientId, text, 'done', nowIso);
    if (profileLocked) db.prepare('UPDATE chat_messages SET profile_locked = 1 WHERE id = ?').run(id);
    index(db, id, text);
    return id;
  })();
}

export function startAssistant(db: Db, chatId: string, nowIso: string): string {
  return insert(db, chatId, 'assistant', null, [], 'streaming', nowIso);
}

export function saveAssistant(db: Db, id: string, turn: ApiMessage[], status: 'done' | 'failed' | 'stopped', errorCode: string | null): void {
  db.transaction(() => {
    db.prepare('UPDATE chat_messages SET content_json = ?, status = ?, error_code = ? WHERE id = ?').run(JSON.stringify(turn), status, errorCode, id);
    if (usedProfile(turn)) markProfile(db, db.prepare('SELECT conversation_id FROM chat_messages WHERE id = ?').pluck().get(id) as string, id);
    index(db, id, status === 'failed' ? null : answerText(turn));
  })();
}

/** role is left out when listing recent chats (the snippet is then the first question). */
export type ChatHit = { chatId: string; title: string; date: string; role?: 'user' | 'assistant'; snippet: string };

/** Past messages matching every term (each quoted, so FTS5 syntax is never parsed), best bm25 matches, then newest first.
 * Without a query: the most recently active chats with their first question and its date (from/to apply to that date), newest first. */
/** hideProfile leaves out chats that hold profile data. */
export function searchChats(db: Db, q: { query?: string; from?: string; to?: string; limit: number }, excludeChatId?: string, hideProfile = false): { results: ChatHit[] } {
  const visible = hideProfile ? 'AND c.profile_seq IS NULL' : '';
  // owner-local days as UTC instants (a date-time without Z parses in the process time zone)
  const at = (day: string) => new Date(`${day}T00:00:00`).toISOString();
  const range = [q.from ? at(q.from) : '', q.to ? at(addDays(q.to, 1)) : '9', excludeChatId ?? null, q.limit];
  if (!q.query) {
    const chats = db.prepare(`SELECT c.id AS chatId, c.title, f.created_at AS createdAt, f.content_json AS first
      FROM chat_conversations c JOIN chat_messages f ON f.id = (SELECT id FROM chat_messages WHERE conversation_id = c.id AND role = 'user' ORDER BY seq LIMIT 1)
      WHERE f.created_at >= ? AND f.created_at < ? AND c.id IS NOT ? ${visible}
      ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`).all(...range) as { chatId: string; title: string; createdAt: string; first: string }[];
    return { results: chats.map(({ createdAt, first, ...c }) => {
      const text = JSON.parse(first) as string;
      return { ...c, date: localDay(new Date(createdAt)), snippet: text.length > 200 ? `${text.slice(0, 200)}…` : text };
    }) };
  }
  // a term with no letter or digit tokenizes to nothing
  const terms = q.query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).map((t) => `"${t.replaceAll('"', '""')}"`);
  const hits = db.prepare(`SELECT c.id AS chatId, c.title, m.created_at AS createdAt, m.role, snippet(chat_search, 0, '[', ']', '…', 24) AS snippet
    FROM chat_search JOIN chat_messages m ON m.id = chat_search.message_id JOIN chat_conversations c ON c.id = m.conversation_id
    WHERE chat_search MATCH ? AND m.created_at >= ? AND m.created_at < ? AND c.id IS NOT ? ${visible} ORDER BY rank LIMIT ?`)
    .all(terms.join(' '), ...range) as (Omit<ChatHit, 'date'> & { createdAt: string })[];
  hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { results: hits.map(({ createdAt, ...h }) => ({ ...h, date: localDay(new Date(createdAt)) })) };
}

/** The seq of a failed last answer, else null. */
function failedTail(db: Db, chatId: string): number | null {
  const last = db.prepare('SELECT seq, role, status FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1').get(chatId) as Pick<Row, 'seq' | 'role' | 'status'> | undefined;
  return last?.role === 'assistant' && last.status === 'failed' ? last.seq : null;
}

export function dropFailedTail(db: Db, chatId: string): void {
  const seq = failedTail(db, chatId);
  if (seq === null) return;
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND (seq = ? OR (seq = ? AND role = \'user\'))').run(chatId, seq, seq - 1);
  // profile data that came only with the dropped answer leaves with it (profile_seq is the first answer that got any)
  db.prepare('UPDATE chat_conversations SET profile_seq = NULL WHERE id = ? AND profile_seq >= ?').run(chatId, seq);
  // an emptied chat takes its title from the next question
  db.prepare('UPDATE chat_conversations SET title = \'\', profile_title = 0 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id = ?)').run(chatId, chatId);
}

/** A stored turn for replay: drops thinking (its signature binds it to the system prompt and tools it was written under, and only the turn
 * being answered needs it) and empty text, then trailing messages until one is an assistant message with text, minus its unanswered tool_use. */
function trimTurn(turn: ApiMessage[]): ApiMessage[] {
  const out = turn.map((m) => (m.role === 'assistant'
    ? { ...m, content: blocks(m).filter((b) => (b.type !== 'text' || b.text) && b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m));
  while (out.length) {
    const last = out.at(-1)!;
    if (last.role === 'assistant') {
      // and a server tool call (search, code run) the answer stopped before the result of, with the searches that code run made; one with a
      // result stays, since its result and its searches point back at it
      const answered = new Set(blocks(last).map((b) => b.tool_use_id));
      const cut = new Set(blocks(last).filter((b) => b.type === 'server_tool_use' && !answered.has(b.id)).map((b) => b.id));
      last.content = blocks(last).filter((b) => b.type !== 'tool_use' && !cut.has(b.id) && !cut.has((b.caller as { tool_id?: string } | undefined)?.tool_id));
      if (last.content.some((b) => b.type === 'text')) break;
    }
    out.pop();
  }
  return out;
}

// the day a question was asked rides with it (not in the system prompt), so every replay of it is byte-identical; so does the profile lock
export const LOCKED_NOTE = 'The financial profile is locked for this question: the profile, jobs, pay_stubs and tax_years tools refuse. If the question needs '
  + 'them, say the profile is locked and ask the owner to unlock it, then ask again.';
const asked = (r: Row): Block => ({ type: 'text', text: `(Asked on ${localDay(new Date(r.created_at))}, ${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}.)`
  + (r.profile_locked ? ` ${LOCKED_NOTE}` : '') });

/** The conversation as Anthropic messages. activeAssistantId (the answer being written) is left out but its question stays, so it is last. */
export function replay(db: Db, chatId: string, activeAssistantId?: string): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const r of rows(db, chatId)) {
    if (r.id === activeAssistantId) continue;
    if (r.role === 'user') { out.push({ role: 'user', content: [{ type: 'text', text: JSON.parse(r.content_json) as string }, asked(r)] }); continue; }
    const turn = r.status === 'done' || r.status === 'stopped' ? trimTurn(JSON.parse(r.content_json) as ApiMessage[]) : [];
    if (turn.length) out.push(...turn);
    else if (out.at(-1)?.role === 'user') out.pop();
  }
  // a question left without an answer row sits next to the following one
  return out.reduce<ApiMessage[]>((acc, m) => {
    const prev = acc.at(-1);
    if (prev?.role === 'user' && m.role === 'user') prev.content = [...blocks(prev), ...blocks(m)];
    else acc.push(m);
    return acc;
  }, []);
}
