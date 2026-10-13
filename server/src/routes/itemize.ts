import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SaveItemsBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import type { Db } from '../db.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { computeShares, currentLines, getItemization, ME, ShareError } from '../itemize.ts';
import { getTransaction } from '../ledger.ts';
import { assertPersonTaggable } from '../people.ts';
import { ReaderError } from '../receipt-reader.ts';
import { parseBody } from '../validate.ts';
import { writeSplit } from './ledger.ts';

function replaceItems(db: Db, txnId: string, items: { name: string; amountCents: number; people: string[] }[]): void {
  db.prepare('DELETE FROM receipt_items WHERE transaction_id = ?').run(txnId);
  const insert = db.prepare('INSERT INTO receipt_items (id, transaction_id, position, name, amount_cents, people) VALUES (?, ?, ?, ?, ?, ?)');
  items.forEach((i, n) => insert.run(randomUUID(), txnId, n, i.name, i.amountCents, JSON.stringify(i.people)));
}

export function itemizeRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const hasReceipt = (id: string) => db.prepare('SELECT 1 FROM receipts r JOIN transactions t ON t.id = r.transaction_id WHERE r.transaction_id = ? AND t.removed_at IS NULL').get(id) !== undefined;
  const assertReceipt = (id: string) => { if (!hasReceipt(id)) throw new ApiError(404, 'NOT_FOUND', 'receipt not found'); };

  // no idempotency key: reading again replaces the items
  app.post<{ Params: { id: string } }>('/v1/transactions/:id/receipt/read', async (req) => {
    const id = req.params.id;
    assertReceipt(id);
    const txn = getTransaction(db, id)!;
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
      const txn = getTransaction(db, id)!;
      if (txn.amountCents >= 0) throw new ApiError(409, 'NOT_MONEY_OUT', 'only money out can be itemized');
      const payer = txn.paidByPersonId;
      body.items.forEach((item, i) => item.people.forEach((p) => {
        if (p === ME) return;
        if (payer && p !== payer) throw new ApiError(400, 'INVALID_REQUEST', `items.${i}.people: only you and the person who paid`, `items.${i}.people`);
        assertPersonTaggable(db, p, `items.${i}.people`, id);
      }));
      const itemsTotal = body.items.reduce((s, i) => s + i.amountCents, 0);
      const target = payer ? itemsTotal + body.taxCents + body.tipCents + body.feesCents : -txn.amountCents;
      let shares;
      try {
        ({ shares } = computeShares({ items: body.items, taxCents: body.taxCents, tipCents: body.tipCents, feesCents: body.feesCents, targetCents: target }));
      } catch (e) {
        if (e instanceof ShareError) throw new ApiError(400, 'INVALID_REQUEST', `items: ${e.message}`, 'items');
        throw e;
      }
      const now = deps.now().toISOString();
      if (payer) {
        const mine = shares.find((s) => s.person === ME)?.cents ?? 0;
        if (mine <= 0) throw new ApiError(400, 'INVALID_REQUEST', 'items: your share must be more than zero', 'items');
        db.prepare('UPDATE transactions SET amount_cents = ?, updated_at = ? WHERE id = ?').run(-mine, now, id);
      } else {
        const ownerCategory = txn.splitLines.length ? (txn.splitLines.find((l) => !l.personId)?.categoryId ?? null) : txn.categoryId;
        const lines = shares.map((s) => s.person === ME
          ? { amountCents: -s.cents, categoryId: ownerCategory }
          : { amountCents: -s.cents, categoryId: null, personId: s.person });
        if (lines.length >= 2) {
          writeSplit(db, id, txn.amountCents, lines, 'items', now);
        } else {
          // one share: no split; the whole row is mine (owner category) or that person's
          db.prepare('DELETE FROM split_lines WHERE transaction_id = ?').run(id);
          const only = shares[0]!.person;
          // all mine with no category: the flag stays as it was, so the bank category can still map once posted
          const category = only === ME ? ownerCategory : null;
          db.prepare('UPDATE transactions SET category_id = ?, person_id = ?, category_owner_set = CASE WHEN ? THEN category_owner_set ELSE 1 END, updated_at = ? WHERE id = ?')
            .run(category, only === ME ? null : only, only === ME && category === null ? 1 : 0, now, id);
        }
      }
      replaceItems(db, id, body.items);
      db.prepare('UPDATE receipts SET tax_cents = ?, tip_cents = ?, fees_cents = ?, applied_lines = ? WHERE transaction_id = ?')
        .run(body.taxCents, body.tipCents, body.feesCents, JSON.stringify(currentLines(db, id)), id);
      return { status: 200, body: getTransaction(db, id) };
    });
    return reply.code(r.status).send(r.body);
  });
}
