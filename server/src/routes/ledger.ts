import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreateTransactionBody, ListTransactionsQuery, PatchAccountBody, PatchTransactionBody, PutSplitsBody, SpendingQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { assertPersonTaggable, owedToYouCents, suggestions } from '../people.ts';
import { assertCategoryExists, getHome, getSpending, getTransaction, learnCategory, listAccounts, listCategories, listTransactions } from '../ledger.ts';

export function ledgerRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/v1/accounts', async () => listAccounts(db));
  app.get('/v1/categories', async () => listCategories(db));

  app.patch<{ Params: { id: string } }>('/v1/accounts/:id', async (req, reply) => {
    const body = parseBody(PatchAccountBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      if (db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(body.name, req.params.id).changes === 0) {
        throw new ApiError(404, 'NOT_FOUND', 'account not found');
      }
      return { status: 200, body: listAccounts(db).find((a) => a.id === req.params.id) };
    });
    return reply.code(r.status).send(r.body);
  });
  app.get('/v1/transactions', async (req) => listTransactions(db, parseBody(ListTransactionsQuery, req.query)));
  // people.ts reads through ledger.ts, so Home's Who Owes Me fields are added here rather than inside getHome
  app.get('/v1/home', async () => ({
    ...getHome(db), owedToYouCents: owedToYouCents(db), repaymentSuggestions: suggestions(db, deps.now()).length,
  }));
  app.get('/v1/spending', async (req) => getSpending(db, parseBody(SpendingQuery, req.query)));

  app.get<{ Params: { id: string } }>('/v1/transactions/:id', async (req) => {
    const t = getTransaction(db, req.params.id);
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
    return t;
  });

  app.patch<{ Params: { id: string } }>('/v1/transactions/:id', async (req, reply) => {
    const body = parseBody(PatchTransactionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = getTransaction(db, req.params.id);
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      // a split transaction's categories and people live on its lines (e.g. a stale client that loaded it before the split)
      if ((body.categoryId !== undefined || body.personId !== undefined) && current.splitLines.length) {
        throw new ApiError(409, 'SPLIT_TRANSACTION', 'tag a split transaction through its lines', body.categoryId !== undefined ? 'categoryId' : 'personId');
      }
      assertCategoryExists(db, body.categoryId, 'categoryId');
      assertPersonTaggable(db, body.personId, 'personId', current.id);
      const sets: string[] = [];
      const args: unknown[] = [];
      // person and category are exclusive: setting one clears the other; either way the owner decided
      if (body.categoryId !== undefined) {
        sets.push('category_id = ?', 'category_owner_set = 1');
        args.push(body.categoryId);
        if (body.categoryId !== null) sets.push('person_id = NULL');
      }
      if (body.personId !== undefined) {
        sets.push('person_id = ?', 'category_owner_set = 1');
        args.push(body.personId);
        if (body.personId !== null) sets.push('category_id = NULL');
      }
      if (body.payee !== undefined) { sets.push('payee = ?'); args.push(body.payee); }
      if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes); }
      const now = deps.now().toISOString();
      db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now, req.params.id);
      if (body.categoryId) learnCategory(db, req.params.id, body.categoryId, now);
      return { status: 200, body: getTransaction(db, req.params.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.put<{ Params: { id: string } }>('/v1/transactions/:id/splits', async (req, reply) => {
    const body = parseBody(PutSplitsBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const txn = getTransaction(db, req.params.id);
      if (!txn) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (!body.lines.length && !txn.splitLines.length) return { status: 200, body: txn };
      body.lines.forEach((l, i) => assertCategoryExists(db, l.categoryId, `lines.${i}.categoryId`));
      body.lines.forEach((l, i) => assertPersonTaggable(db, l.personId, `lines.${i}.personId`, txn.id));
      // lines share the transaction's sign: the app enters them as positive amounts, so it couldn't show anything else
      if (body.lines.some((l) => (l.amountCents < 0) !== (txn.amountCents < 0))) {
        throw new ApiError(400, 'INVALID_REQUEST', 'lines: every line must have the same sign as the transaction', 'lines');
      }
      if (body.lines.length && body.lines.reduce((s, l) => s + l.amountCents, 0) !== txn.amountCents) {
        throw new ApiError(400, 'INVALID_REQUEST', 'lines: must add up to the transaction amount', 'lines');
      }
      const now = deps.now().toISOString();
      db.prepare('DELETE FROM split_lines WHERE transaction_id = ?').run(txn.id);
      // ids sort in entry order (lines are read back ORDER BY id)
      const insert = db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id, notes, person_id) VALUES (?, ?, ?, ?, ?, ?)');
      body.lines.forEach((l, i) => insert.run(`${String(i).padStart(2, '0')}-${randomUUID()}`, txn.id, l.amountCents, l.categoryId, l.notes ?? null, l.personId ?? null));
      // a split transaction's category lives on its lines; the owner decided, so learned mappings leave it alone
      db.prepare('UPDATE transactions SET category_id = NULL, person_id = NULL, category_owner_set = 1, updated_at = ? WHERE id = ?').run(now, txn.id);
      return { status: 200, body: getTransaction(db, txn.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/transactions', async (req, reply) => {
    const body = parseBody(CreateTransactionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      assertCategoryExists(db, body.categoryId, 'categoryId');
      const id = randomUUID();
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO transactions (id, account_id, source, date, amount_cents, bank_description, payee, category_id, notes, created_at, updated_at)
        VALUES (?, 'manual', 'manual', ?, ?, '', ?, ?, ?, ?, ?)`)
        .run(id, body.date, body.amountCents, body.payee, body.categoryId ?? null, body.notes ?? null, now, now);
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
