import type { FastifyInstance } from 'fastify';
import { LinkInboxBody, SaveItemsBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { getInboxRow, inboxItemization, linkInbox, listInbox, matchInbox, saveInboxItems, storeRead, waitingRow } from '../inbox.ts';
import { readReceipt, ReaderError } from '../receipt-reader.ts';
import { parseBody } from '../validate.ts';
import { isJpeg, MAX_BYTES } from './receipts.ts';

/** Registered after receiptRoutes, which adds the image/jpeg body parser. */
export function inboxRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const waiting = (id: string) => {
    const row = waitingRow(db, id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'inbox receipt not found');
    return row;
  };
  // runs after a committed write: a matching error must not turn it into a 500
  const rematch = (id?: string) => {
    try {
      matchInbox(deps, id);
    } catch {
      console.error('[hermes] inbox matching failed');
    }
  };
  const entry = (id: string) => listInbox(db, localDay(deps.now())).waiting.find((w) => w.id === id)!;

  async function readInBackground(id: string): Promise<void> {
    const row = getInboxRow(db, id);
    if (!row?.jpeg) return;
    if (!deps.receiptReader) { db.prepare('UPDATE inbox_receipts SET read_failed = 1 WHERE id = ?').run(id); return; }
    try {
      const r = await readReceipt(deps, `inbox:${id}`, row.jpeg, true);
      // tags the owner saved while the read ran win over it
      if (getInboxRow(db, id)?.tagged) return;
      if (storeRead(db, id, r, deps.now().toISOString())) rematch(id);
    } catch (e) {
      console.error(`[hermes] inbox read failed code=${e instanceof ReaderError ? e.code : 'UNKNOWN'}`);
      db.prepare('UPDATE inbox_receipts SET read_failed = 1 WHERE id = ? AND read_at IS NULL AND linked_at IS NULL').run(id);
    }
  }

  app.put<{ Params: { id: string } }>('/v1/receipts/inbox/:id', { bodyLimit: MAX_BYTES }, async (req) => {
    const id = req.params.id;
    if (id.length < 1 || id.length > 100) throw new ApiError(400, 'INVALID_REQUEST', 'id: 1 to 100 characters', 'id');
    if (req.headers['content-type'] !== 'image/jpeg') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the receipt as image/jpeg');
    if (!isJpeg(req.body)) throw new ApiError(400, 'INVALID_IMAGE', 'the receipt must be a JPEG');
    const existing = getInboxRow(db, id);
    if (existing) return { id, bytes: existing.bytes };
    const now = deps.now().getTime();
    const sent = Date.parse(String(req.headers['x-captured-at'] ?? ''));
    const captured = sent <= now + 5 * 60_000 && sent >= now - 60 * 86_400_000 ? sent : now;
    db.transaction(() => {
      const count = db.prepare('SELECT COUNT(*) FROM inbox_receipts WHERE linked_at IS NULL').pluck().get() as number;
      if (count >= 200) throw new ApiError(409, 'INBOX_FULL', 'the receipt inbox is full (200 waiting); link or delete a receipt before uploading another');
      db.prepare('INSERT INTO inbox_receipts (id, jpeg, bytes, captured_at) VALUES (?, ?, ?, ?)').run(id, req.body, (req.body as Buffer).length, new Date(captured).toISOString());
    })();
    void readInBackground(id).catch(() => console.error('[hermes] inbox read failed code=UNKNOWN'));
    return { id, bytes: req.body.length };
  });

  app.get('/v1/receipts/inbox', async () => listInbox(db, localDay(deps.now())));

  app.get<{ Params: { id: string } }>('/v1/receipts/inbox/:id/photo', async (req, reply) => {
    const row = waiting(req.params.id);
    return reply.type('image/jpeg').send(row.jpeg);
  });

  app.post<{ Params: { id: string } }>('/v1/receipts/inbox/:id/read', async (req) => {
    const row = waiting(req.params.id);
    if (!deps.receiptReader) throw new ApiError(503, 'READER_NOT_CONFIGURED', 'receipt reading is not set up');
    const state = (r: typeof row) => JSON.stringify([r.items, r.tagged, r.tax_cents, r.tip_cents, r.fees_cents]);
    const before = state(row);
    let r;
    try {
      r = await readReceipt(deps, `inbox:${row.id}`, row.jpeg!);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      console.error(`[hermes] inbox read failed code=${e instanceof ReaderError ? e.code : 'UNKNOWN'}`);
      throw new ApiError(502, 'READ_FAILED', "couldn't read the receipt");
    }
    const now = getInboxRow(db, row.id);
    if (now?.tagged === 1 && state(now) !== before) throw new ApiError(409, 'CHANGED', 'the items changed while reading');
    if (!storeRead(db, row.id, r, deps.now().toISOString())) throw new ApiError(404, 'NOT_FOUND', 'inbox receipt not found');
    rematch(row.id);
    const after = getInboxRow(db, row.id)!;
    if (after.linked_at !== null) throw new ApiError(409, 'LINKED', 'the receipt was linked to its charge');
    return entry(row.id);
  });

  app.get<{ Params: { id: string } }>('/v1/receipts/inbox/:id/items', async (req) => inboxItemization(waiting(req.params.id)));

  app.put<{ Params: { id: string } }>('/v1/receipts/inbox/:id/items', async (req, reply) => {
    const body = parseBody(SaveItemsBody, req.body);
    const r = idempotentWrite(deps, req, () => ({ status: 200, body: saveInboxItems(db, req.params.id, body) }));
    rematch(req.params.id);
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/v1/receipts/inbox/:id/link', async (req, reply) => {
    const body = parseBody(LinkInboxBody, req.body);
    const r = idempotentWrite(deps, req, () => ({ status: 200, body: linkInbox(deps, req.params.id, body.transactionId) }));
    rematch();
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/v1/receipts/inbox/:id/dismiss', async (req, reply) => {
    db.prepare('UPDATE inbox_receipts SET dismissed_at = COALESCE(dismissed_at, ?) WHERE id = ? AND linked_at IS NOT NULL').run(deps.now().toISOString(), req.params.id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/v1/receipts/inbox/:id', async (req, reply) => {
    db.prepare('DELETE FROM inbox_receipts WHERE id = ?').run(req.params.id);
    return reply.code(204).send();
  });
}
