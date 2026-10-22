import type { FastifyInstance } from 'fastify';
import { SaveItemsBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { applyItems, getItemization, ME, replaceItems } from '../itemize.ts';
import { getTransaction } from '../ledger.ts';
import { ReaderError } from '../receipt-reader.ts';
import { parseBody } from '../validate.ts';

export function itemizeRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const hasReceipt = (id: string) => db.prepare('SELECT 1 FROM receipts r JOIN transactions t ON t.id = r.transaction_id WHERE r.transaction_id = ? AND t.removed_at IS NULL').get(id) !== undefined;
  const assertReceipt = (id: string) => { if (!hasReceipt(id)) throw new ApiError(404, 'NOT_FOUND', 'receipt not found'); };

  // no idempotency key: reading again replaces the items
  app.post<{ Params: { id: string } }>('/v1/transactions/:id/receipt/read', async (req) => {
    const id = req.params.id;
    assertReceipt(id);
    const txn = getTransaction(db, id, localDay(deps.now()))!;
    if (txn.amountCents >= 0) throw new ApiError(409, 'NOT_MONEY_OUT', 'only money out can be itemized');
    const reader = deps.receiptReader;
    if (!reader) throw new ApiError(503, 'READER_NOT_CONFIGURED', 'receipt reading is not set up');
    const { jpeg, created_at: photoAt } = db.prepare('SELECT jpeg, created_at FROM receipts WHERE transaction_id = ?').get(id) as { jpeg: Buffer; created_at: string };
    let result;
    try {
      result = await reader.read(jpeg);
    } catch (e) {
      console.error(`[hermes] receipt read failed code=${e instanceof ReaderError ? e.code : 'UNKNOWN'}`);
      throw new ApiError(502, 'READ_FAILED', "couldn't read the receipt");
    }
    db.transaction(() => {
      // the photo may have been replaced or deleted while Claude was reading
      assertReceipt(id);
      const stored = db.prepare('UPDATE receipts SET tax_cents = ?, tip_cents = ?, fees_cents = ?, total_cents = ?, read_at = ?, model = ?, applied_lines = NULL WHERE transaction_id = ? AND created_at = ?')
        .run(result.taxCents, result.tipCents, result.feesCents, result.totalCents, deps.now().toISOString(), result.model, id, photoAt);
      if (stored.changes === 0) throw new ApiError(409, 'RECEIPT_CHANGED', 'the receipt photo changed while it was being read');
      // on a "they paid" row most items are shared, so they start as me + the payer
      const people = txn.paidByPersonId ? [ME, txn.paidByPersonId] : [ME];
      replaceItems(db, id, result.items.map((i) => ({ ...i, people })));
    })();
    return getItemization(db, id);
  });

  app.get<{ Params: { id: string } }>('/v1/transactions/:id/receipt/items', async (req) => {
    assertReceipt(req.params.id);
    return getItemization(db, req.params.id);
  });

  app.put<{ Params: { id: string } }>('/v1/transactions/:id/receipt/items', async (req, reply) => {
    const body = parseBody(SaveItemsBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const id = req.params.id;
      assertReceipt(id);
      if (getTransaction(db, id, localDay(deps.now()))!.amountCents >= 0) throw new ApiError(409, 'NOT_MONEY_OUT', 'only money out can be itemized');
      return { status: 200, body: applyItems(db, id, body, deps.now().toISOString()) };
    });
    return reply.code(r.status).send(r.body);
  });
}
