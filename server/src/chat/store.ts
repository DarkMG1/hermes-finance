import { randomUUID } from 'node:crypto';
import type { ChatDetail, ChatList, ChatMessage, ChatSummary } from '@hermes/shared';
import type { Db } from '../db.ts';
import { localDay } from '../days.ts';
import { toolLabel } from './tools.ts';

type Block = Record<string, unknown>;
export type ApiMessage = { role: 'user' | 'assistant'; content: string | Block[] };
type Row = { id: string; seq: number; role: 'user' | 'assistant'; content_json: string; status: ChatMessage['status']; error_code: string | null; created_at: string };

const SUMMARY = 'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM chat_conversations';
const rows = (db: Db, chatId: string) =>
  db.prepare('SELECT id, seq, role, content_json, status, error_code, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY seq').all(chatId) as Row[];
const blocks = (m: ApiMessage): Block[] => (Array.isArray(m.content) ? m.content : []);

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
    // joined like the stream joins them, so a reload shows exactly what the stream showed
    const text = all.filter((b) => b.type === 'text' && b.text).map((b) => b.text as string).join('\n\n');
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
    return insert(db, chatId, 'user', clientId, text, 'done', nowIso);
  })();
}

export function startAssistant(db: Db, chatId: string, nowIso: string): string {
  return insert(db, chatId, 'assistant', null, [], 'streaming', nowIso);
}

export function saveAssistant(db: Db, id: string, turn: ApiMessage[], status: 'done' | 'failed' | 'stopped', errorCode: string | null): void {
  db.prepare('UPDATE chat_messages SET content_json = ?, status = ?, error_code = ? WHERE id = ?').run(JSON.stringify(turn), status, errorCode, id);
}

export function dropFailedTail(db: Db, chatId: string): void {
  const last = db.prepare('SELECT seq, role, status FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1').get(chatId) as Pick<Row, 'seq' | 'role' | 'status'> | undefined;
  if (last?.role !== 'assistant' || last.status !== 'failed') return;
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND (seq = ? OR (seq = ? AND role = \'user\'))').run(chatId, last.seq, last.seq - 1);
}

/** A turn cut mid-round (stopped): drops empty text, then trailing messages until one is an assistant message with text, minus its unanswered tool_use. */
function trimTurn(turn: ApiMessage[]): ApiMessage[] {
  const out = turn.map((m) => (m.role === 'assistant' ? { ...m, content: blocks(m).filter((b) => b.type !== 'text' || b.text) } : m));
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
