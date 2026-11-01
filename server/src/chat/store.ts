import { randomUUID } from 'node:crypto';
import type { ChatDetail, ChatList, ChatMessage, ChatSummary } from '@hermes/shared';
import type { Db } from '../db.ts';
import { addDays, localDay } from '../days.ts';
import { toolLabel } from './labels.ts';

type Block = Record<string, unknown>;
export type ApiMessage = { role: 'user' | 'assistant'; content: string | Block[] };
type Row = { id: string; seq: number; role: 'user' | 'assistant'; content_json: string; status: ChatMessage['status']; error_code: string | null; created_at: string };

const SUMMARY = 'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM chat_conversations';
const rows = (db: Db, chatId: string) =>
  db.prepare('SELECT id, seq, role, content_json, status, error_code, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY seq').all(chatId) as Row[];
const blocks = (m: ApiMessage): Block[] => (Array.isArray(m.content) ? m.content : []);
// joined like the stream joins them, so a reload shows exactly what the stream showed
const answerText = (turn: ApiMessage[]): string =>
  turn.filter((m) => m.role === 'assistant').flatMap(blocks).filter((b) => b.type === 'text' && b.text).map((b) => b.text as string).join('\n\n');
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

export function listChats(db: Db): ChatList {
  return { chats: db.prepare(`${SUMMARY} ORDER BY updated_at DESC, created_at DESC`).all() as ChatSummary[] };
}

export function getChat(db: Db, id: string): ChatDetail | null {
  const chat = db.prepare(`${SUMMARY} WHERE id = ?`).get(id) as ChatSummary | undefined;
  if (!chat) return null;
  const messages = rows(db, id).map((r): ChatMessage => {
    const base = { id: r.id, role: r.role, status: r.status, errorCode: r.error_code, createdAt: r.created_at };
    if (r.role === 'user') return { ...base, text: JSON.parse(r.content_json) as string, tools: [] };
    const turn = JSON.parse(r.content_json) as ApiMessage[];
    const all = turn.filter((m) => m.role === 'assistant').flatMap(blocks);
    const ran = new Set(turn.filter((m) => m.role === 'user').flatMap(blocks).map((b) => b.tool_use_id));
    const text = answerText(turn);
    const tools = all.filter((b) => b.type === 'tool_use' && ran.has(b.id)).map((b) => {
      const input = b.input as Record<string, unknown>;
      return { name: b.name as string, input, label: toolLabel(b.name as string, input) };
    });
    return { ...base, text, tools };
  });
  return { ...chat, messages };
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

export function addUserMessage(db: Db, chatId: string, clientId: string, text: string, nowIso: string): string {
  return db.transaction(() => {
    db.prepare('UPDATE chat_conversations SET updated_at = ?, title = CASE WHEN title = \'\' THEN ? ELSE title END WHERE id = ?')
      .run(nowIso, text.trim().slice(0, 60), chatId);
    const id = insert(db, chatId, 'user', clientId, text, 'done', nowIso);
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
    index(db, id, status === 'failed' ? null : answerText(turn));
  })();
}

export type ChatHit = { chatId: string; title: string; date: string; role: 'user' | 'assistant'; snippet: string };

/** Past messages matching every term (each quoted, so FTS5 syntax is never parsed), best bm25 matches, then newest first. */
export function searchChats(db: Db, q: { query: string; from?: string; to?: string; limit: number }, excludeChatId?: string): { results: ChatHit[] } {
  // a term with no letter or digit tokenizes to nothing
  const terms = q.query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).map((t) => `"${t.replaceAll('"', '""')}"`);
  // owner-local days as UTC instants (a date-time without Z parses in the process time zone)
  const at = (day: string) => new Date(`${day}T00:00:00`).toISOString();
  const hits = db.prepare(`SELECT c.id AS chatId, c.title, m.created_at AS createdAt, m.role, snippet(chat_search, 0, '[', ']', '…', 24) AS snippet
    FROM chat_search JOIN chat_messages m ON m.id = chat_search.message_id JOIN chat_conversations c ON c.id = m.conversation_id
    WHERE chat_search MATCH ? AND m.created_at >= ? AND m.created_at < ? AND c.id IS NOT ? ORDER BY rank LIMIT ?`)
    .all(terms.join(' '), q.from ? at(q.from) : '', q.to ? at(addDays(q.to, 1)) : '9', excludeChatId ?? null, q.limit) as (Omit<ChatHit, 'date'> & { createdAt: string })[];
  hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { results: hits.map(({ createdAt, ...h }) => ({ ...h, date: localDay(new Date(createdAt)) })) };
}

export function dropFailedTail(db: Db, chatId: string): void {
  const last = db.prepare('SELECT seq, role, status FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1').get(chatId) as Pick<Row, 'seq' | 'role' | 'status'> | undefined;
  if (last?.role !== 'assistant' || last.status !== 'failed') return;
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND (seq = ? OR (seq = ? AND role = \'user\'))').run(chatId, last.seq, last.seq - 1);
}

/** A stored turn for replay: drops thinking (its signature binds it to the system prompt and tools it was written under, and only the turn
 * being answered needs it) and empty text, then trailing messages until one is an assistant message with text, minus its unanswered tool_use. */
function trimTurn(turn: ApiMessage[]): ApiMessage[] {
  const out = turn.map((m) => (m.role === 'assistant'
    ? { ...m, content: blocks(m).filter((b) => (b.type !== 'text' || b.text) && b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m));
  while (out.length) {
    const last = out.at(-1)!;
    if (last.role === 'assistant') {
      last.content = blocks(last).filter((b) => b.type !== 'tool_use');
      if (last.content.some((b) => b.type === 'text')) break;
    }
    out.pop();
  }
  return out;
}

// the day a question was asked rides with it (not in the system prompt), so every replay of it is byte-identical
const asked = (r: Row): Block => ({ type: 'text', text: `(Asked on ${localDay(new Date(r.created_at))}, ${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}.)` });

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
