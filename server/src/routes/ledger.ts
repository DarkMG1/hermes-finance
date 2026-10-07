import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreateTransactionBody, ListTransactionsQuery, PatchTransactionBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { assertCategoryExists, getTransaction, listAccounts, listCategories, listTransactions } from '../ledger.ts';

export function ledgerRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/v1/accounts', async () => listAccounts(db));
  app.get('/v1/categories', async () => listCategories(db));
  app.get('/v1/transactions', async (req) => listTransactions(db, parseBody(ListTransactionsQuery, req.query)));

  app.get<{ Params: { id: string } }>('/v1/transactions/:id', async (req) => {
    const t = getTransaction(db, req.params.id);
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
    return t;
  });

  app.patch<{ Params: { id: string } }>('/v1/transactions/:id', async (req, reply) => {
    const body = parseBody(PatchTransactionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      if (!getTransaction(db, req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      assertCategoryExists(db, body.categoryId, 'categoryId');
      const sets: string[] = [];
      const args: unknown[] = [];
      if (body.categoryId !== undefined) { sets.push('category_id = ?'); args.push(body.categoryId); }
      if (body.payee !== undefined) { sets.push('payee = ?'); args.push(body.payee); }
      if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes); }
      db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, deps.now().toISOString(), req.params.id);
      return { status: 200, body: getTransaction(db, req.params.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/transactions', async (req, reply) => {
    const body = parseBody(CreateTransactionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(body.accountId)) {
        throw new ApiError(400, 'INVALID_REQUEST', 'accountId: unknown account', 'accountId');
      }
      assertCategoryExists(db, body.categoryId, 'categoryId');
      const id = randomUUID();
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO transactions (id, account_id, source, date, amount_cents, bank_description, payee, category_id, notes, created_at, updated_at)
        VALUES (?, ?, 'manual', ?, ?, '', ?, ?, ?, ?, ?)`)
        .run(id, body.accountId, body.date, body.amountCents, body.payee, body.categoryId ?? null, body.notes ?? null, now, now);
      return { status: 201, body: getTransaction(db, id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete<{ Params: { id: string } }>('/v1/transactions/:id', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      const row = db.prepare('SELECT source FROM transactions WHERE id = ? AND removed_at IS NULL').get(req.params.id) as { source: string } | undefined;
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (row.source !== 'manual') throw new ApiError(409, 'BANK_TRANSACTION', 'only manual transactions can be deleted');
      db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });
}
