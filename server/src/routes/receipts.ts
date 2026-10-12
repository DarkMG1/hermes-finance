import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';

const MAX_BYTES = 5 * 1024 * 1024;

export function receiptRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  const assertLive = (id: string) => {
    if (!db.prepare('SELECT 1 FROM transactions WHERE id = ? AND removed_at IS NULL').get(id)) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
  };

  app.put<{ Params: { id: string } }>('/v1/transactions/:id/receipt', { bodyLimit: MAX_BYTES }, async (req) => {
    if (req.headers['content-type'] !== 'image/jpeg') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the receipt as image/jpeg');
    const jpeg = req.body;
    if (!Buffer.isBuffer(jpeg) || jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
      throw new ApiError(400, 'INVALID_IMAGE', 'the receipt must be a JPEG');
    }
    assertLive(req.params.id);
    db.prepare(`INSERT INTO receipts (transaction_id, jpeg, bytes, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (transaction_id) DO UPDATE SET jpeg = excluded.jpeg, bytes = excluded.bytes, created_at = excluded.created_at`)
      .run(req.params.id, jpeg, jpeg.length, deps.now().toISOString());
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
    db.prepare('DELETE FROM receipts WHERE transaction_id = ?').run(req.params.id);
    return reply.code(204).send();
  });
}
