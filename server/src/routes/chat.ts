import type { FastifyInstance } from 'fastify';
import { SendChatBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { parseBody } from '../validate.ts';
import { answer, type ChatEvent } from '../chat/agent.ts';
import { toolLabel } from '../chat/tools.ts';
import { addUserMessage, createChat, deleteChat, dropFailedTail, findByClientId, getChat, listChats, saveAssistant, startAssistant } from '../chat/store.ts';

const busyChats = new WeakMap<Deps['db'], Set<string>>();

export function chatRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const busy = busyChats.get(db) ?? new Set<string>();
  busyChats.set(db, busy);
  // a restart mid-answer leaves rows no one will finish
  db.prepare("UPDATE chat_messages SET status = 'failed', error_code = 'INTERRUPTED' WHERE status = 'streaming'").run();

  const find = (id: string) => {
    const chat = getChat(db, id);
    if (!chat) throw new ApiError(404, 'NOT_FOUND', 'chat not found');
    return chat;
  };
  const chatBusy = () => new ApiError(409, 'CHAT_BUSY', 'an answer is still being written');

  app.get('/v1/chats', async () => listChats(db));

  app.post('/v1/chats', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => ({ status: 201, body: createChat(db, deps.now().toISOString()) }));
    return reply.code(r.status).send(r.body);
  });

  app.get<{ Params: { id: string } }>('/v1/chats/:id', async (req) => find(req.params.id));

  app.delete<{ Params: { id: string } }>('/v1/chats/:id', async (req, reply) => {
    if (busy.has(req.params.id)) throw chatBusy();
    if (!deleteChat(db, req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'chat not found');
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/chats/:id/messages', async (req, reply) => {
    const body = parseBody(SendChatBody, req.body);
    const chatId = req.params.id;
    const chat = find(chatId);
    if (!deps.claude) throw new ApiError(503, 'AI_NOT_CONFIGURED', 'AI is not configured');
    if (busy.has(chatId)) throw chatBusy();
    const prior = findByClientId(db, body.clientId);
    if (prior && prior.chatId !== chatId) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'clientId was used in another chat');
    if (prior?.assistant?.status === 'streaming') throw chatBusy();
    // a resend after a dropped connection gets the stored answer, not a second one
    const stored = prior?.assistant?.status === 'done' || prior?.assistant?.status === 'stopped'
      ? chat.messages.find((m) => m.id === prior.assistant!.id) : undefined;
    const now = deps.now().toISOString();
    // a failed answer is replaced together with its question, so a rerun of the same clientId keeps one user row
    const assistantId = stored ? null : db.transaction(() => {
      dropFailedTail(db, chatId);
      addUserMessage(db, chatId, body.clientId, body.text, now);
      return startAssistant(db, chatId, now);
    })();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    raw.flushHeaders();
    const write = (e: ChatEvent) => { raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); };
    if (!assistantId) {
      for (const t of stored!.tools) write({ type: 'tool', name: t.name, label: toolLabel(t.name, t.input), input: t.input });
      if (stored!.text) write({ type: 'text', text: stored!.text });
      write({ type: 'done', messageId: stored!.id, costCents: 0, status: stored!.status as 'done' | 'stopped' });
      raw.end();
      return;
    }
    busy.add(chatId);
    let finished = false;
    const ac = new AbortController();
    raw.on('close', () => { if (!finished) ac.abort(); });
    const keepalive = setInterval(() => raw.write(': keepalive\n\n'), 15_000);
    try {
      await answer(deps, chatId, assistantId, write, ac.signal);
    } catch (e) {
      // answer() handles Claude errors itself; anything else must not leave the row streaming or reject after hijack
      console.error(`[hermes] chat route failed ${(e as Error).name}`);
      try { saveAssistant(db, assistantId, [], 'failed', 'INTERNAL'); } catch { /* the stream still ends with the error */ }
      write({ type: 'error', code: 'INTERNAL' });
    } finally {
      finished = true;
      clearInterval(keepalive);
      busy.delete(chatId);
      raw.end();
    }
  });

  app.get('/v1/ai/usage', async () => deps.claude?.usage() ?? { month: localDay(deps.now()).slice(0, 7), costCents: 0, backupActive: false });
}
