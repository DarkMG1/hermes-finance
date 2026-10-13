import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';

// production nginx caps bodies at 3 MB (client_max_body_size 3m)
export const MAX_BYTES = 3 * 1024 * 1024;
export const isJpeg = (b: unknown): b is Buffer => Buffer.isBuffer(b) && b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function receiptRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const assertLive = (id: string) => {
    if (!db.prepare('SELECT 1 FROM transactions WHERE id = ? AND removed_at IS NULL').get(id)) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
  };

  app.put<{ Params: { id: string } }>('/v1/transactions/:id/receipt', { bodyLimit: MAX_BYTES }, async (req) => {
    if (req.headers['content-type'] !== 'image/jpeg') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the receipt as image/jpeg');
    const jpeg = req.body;
    if (!isJpeg(jpeg)) {
      throw new ApiError(400, 'INVALID_IMAGE', 'the receipt must be a JPEG');
    }
    assertLive(req.params.id);
    if (db.prepare('SELECT forgiven FROM transactions WHERE id = ?').pluck().get(req.params.id) === 1) {
      throw new ApiError(409, 'FORGIVENESS_LOCKED', 'delete the forgiveness to change it');
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (transaction_id) DO UPDATE SET jpeg = excluded.jpeg, bytes = excluded.bytes, created_at = excluded.created_at,
          tax_cents = NULL, tip_cents = NULL, fees_cents = NULL, total_cents = NULL, read_at = NULL, model = NULL, applied_lines = NULL`)
        .run(req.params.id, jpeg, jpeg.length, deps.now().toISOString());
      // the items belong to the old photo; the split they produced stays
      db.prepare('DELETE FROM receipt_items WHERE transaction_id = ?').run(req.params.id);
      db.prepare('UPDATE inbox_receipts SET linked_transaction_id = NULL WHERE linked_transaction_id = ?').run(req.params.id);
    })();
    return { bytes: jpeg.length };
  });

  app.get<{ Params: { id: string } }>('/v1/transactions/:id/receipt', async (req, reply) => {
    assertLive(req.params.id);
    const row = db.prepare('SELECT jpeg FROM receipts WHERE transaction_id = ?').get(req.params.id) as { jpeg: Buffer } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'receipt not found');
    return reply.type('image/jpeg').send(row.jpeg);
  });

  app.delete<{ Params: { id: string } }>('/v1/transactions/:id/receipt', async (req, reply) => {
    assertLive(req.params.id);
    db.transaction(() => {
      db.prepare('DELETE FROM receipts WHERE transaction_id = ?').run(req.params.id);
      db.prepare('DELETE FROM receipt_items WHERE transaction_id = ?').run(req.params.id);
    })();
    return reply.code(204).send();
  });
}
