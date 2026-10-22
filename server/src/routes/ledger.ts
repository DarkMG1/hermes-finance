import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreateTransactionBody, ExpensesQuery, HistoryExclusionBody, ListTransactionsQuery, NetWorthQuery, PatchAccountBody, PatchSplitLineBody, PatchTransactionBody, PayeeHistoryQuery, PutSplitsBody, SpendingQuery } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { writeSplit } from '../splits.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { assertPersonTaggable, homePeople } from '../people.ts';
import { excludedBy, getExpenses, getPayeeHistory, getReimbursements, getSpending } from '../cashflow.ts';
import { restoreToInbox } from '../inbox.ts';
import { normalizeName } from '../recurring.ts';
import { getNetWorth, localDay } from '../networth.ts';
import { oldestOpenBefore } from '../reconcile.ts';
import { assertCategoryExists, getHome, getTransaction, learnCategory, listAccounts, listCategories, listTransactions } from '../ledger.ts';

export { writeSplit } from '../splits.ts';

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
  app.get('/v1/transactions', async (req) => listTransactions(db, parseBody(ListTransactionsQuery, req.query), localDay(deps.now())));
  // people.ts reads through ledger.ts, so Home's Who Owes Me fields are added here rather than inside getHome
  app.get('/v1/home', async () => ({
    ...getHome(db, localDay(deps.now())), ...homePeople(db, deps.now()),
    toReconcile: oldestOpenBefore(db, localDay(deps.now()).slice(0, 7)),
  }));
  app.get('/v1/expenses', async (req) => getExpenses(db, parseBody(ExpensesQuery, req.query)));
  app.get('/v1/spending', async (req) => getSpending(db, parseBody(SpendingQuery, req.query)));
  app.get('/v1/net-worth', async (req) => getNetWorth(db, parseBody(NetWorthQuery, req.query).range, localDay(deps.now())));
  app.get('/v1/payee-history', async (req) => getPayeeHistory(db, parseBody(PayeeHistoryQuery, req.query), localDay(deps.now())));
  // an upsert or delete: replaying it changes nothing, so no idempotency key
  app.put('/v1/payee-history/exclusions', async (req, reply) => {
    const body = parseBody(HistoryExclusionBody, req.body);
    const [payee, name] = [body.name, body.excludedName].map(normalizeName) as [string, string];
    if (!payee || !name) throw new ApiError(400, 'NO_NAME', 'this name has nothing to match', payee ? 'excludedName' : 'name');
    if (payee === name) throw new ApiError(400, 'INVALID_REQUEST', "excludedName: a payee's own name can't be left out", 'excludedName');
    // the name's own rule, only while it says something shorter rules don't
    if (excludedBy(db, payee)(name, name) === body.excluded) db.prepare('DELETE FROM history_exclusions WHERE payee_key = ? AND excluded_key = ?').run(payee, name);
    else {
      db.prepare(`INSERT INTO history_exclusions (payee_key, excluded_key, excluded) VALUES (?, ?, ?)
        ON CONFLICT (payee_key, excluded_key) DO UPDATE SET excluded = excluded.excluded`).run(payee, name, body.excluded ? 1 : 0);
    }
    return reply.code(204).send();
  });
  app.get('/v1/reimbursements', async () => getReimbursements(db, localDay(deps.now())));

  app.get<{ Params: { id: string } }>('/v1/transactions/:id', async (req) => {
    const t = getTransaction(db, req.params.id, localDay(deps.now()));
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
    return t;
  });

  app.patch<{ Params: { id: string } }>('/v1/transactions/:id', async (req, reply) => {
    const body = parseBody(PatchTransactionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = getTransaction(db, req.params.id, localDay(deps.now()));
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (current.forgiven && (body.categoryId !== undefined || body.personId !== undefined || body.paidByPersonId !== undefined)) {
        throw new ApiError(409, 'FORGIVENESS_LOCKED', 'delete the forgiveness to change it');
      }
      // a split transaction's categories and people live on its lines (e.g. a stale client that loaded it before the split)
      if ((body.categoryId !== undefined || body.personId !== undefined) && current.splitLines.length) {
        throw new ApiError(409, 'SPLIT_TRANSACTION', 'tag a split transaction through its lines', body.categoryId !== undefined ? 'categoryId' : 'personId');
      }
      assertCategoryExists(db, body.categoryId, 'categoryId');
      assertPersonTaggable(db, body.personId, 'personId', current.id);
      if (body.paidByPersonId !== undefined) {
        if (current.source !== 'manual') {
          throw new ApiError(409, 'BANK_TRANSACTION', 'only a manual transaction can be paid by someone else', 'paidByPersonId');
        }
        if (current.splitLines.length) throw new ApiError(409, 'SPLIT_TRANSACTION', 'a split transaction cannot be paid by someone else', 'paidByPersonId');
        if (body.paidByPersonId !== null && current.amountCents >= 0) {
          throw new ApiError(400, 'INVALID_REQUEST', 'paidByPersonId: a payer covers money out', 'paidByPersonId');
        }
        assertPersonTaggable(db, body.paidByPersonId, 'paidByPersonId', current.id, 'payer');
      }
      // a row someone else paid is the owner's own spending, so it never carries a person tag
      const personAfter = body.personId !== undefined ? body.personId : body.categoryId ? null : current.personId;
      const payerAfter = body.paidByPersonId !== undefined ? body.paidByPersonId : current.paidByPersonId;
      if (personAfter && payerAfter) throw new ApiError(400, 'INVALID_REQUEST', 'personId: a row someone else paid is your own spending', 'personId');
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
      if (body.payee !== undefined) { sets.push('payee = ?', 'payee_owner_set = 1'); args.push(body.payee); }
      if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes); }
      if (body.paidByPersonId !== undefined) { sets.push('paid_by_person_id = ?'); args.push(body.paidByPersonId); }
      if (body.repaymentDismissed !== undefined) { sets.push('repayment_dismissed = ?'); args.push(body.repaymentDismissed ? 1 : 0); }
      if (body.date !== undefined) { sets.push('date = ?', 'date_owner_set = 1'); args.push(body.date); }
      const now = deps.now().toISOString();
      db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now, req.params.id);
      if (body.categoryId) learnCategory(db, req.params.id, body.categoryId, now);
      return { status: 200, body: getTransaction(db, req.params.id, localDay(deps.now())) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.put<{ Params: { id: string } }>('/v1/transactions/:id/splits', async (req, reply) => {
    const body = parseBody(PutSplitsBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const txn = getTransaction(db, req.params.id, localDay(deps.now()));
      if (!txn) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (txn.forgiven) throw new ApiError(409, 'FORGIVENESS_LOCKED', 'delete the forgiveness to change it');
      if (txn.paidByPersonId) throw new ApiError(409, 'PAID_BY_PERSON', 'a transaction someone else paid cannot be split', 'lines');
      if (txn.splitLines.some((l) => l.personId !== null || l.payee !== null)
        && body.lines.some((l) => l.personId === undefined || l.payee === undefined)) {
        throw new ApiError(409, 'APP_OUTDATED', 'update the app before saving this split');
      }
      if (!body.lines.length && !txn.splitLines.length) return { status: 200, body: txn };
      writeSplit(db, txn.id, txn.amountCents, body.lines, 'lines', deps.now().toISOString());
      return { status: 200, body: getTransaction(db, txn.id, localDay(deps.now())) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.patch<{ Params: { id: string; lineId: string } }>('/v1/transactions/:id/lines/:lineId', async (req, reply) => {
    const body = parseBody(PatchSplitLineBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const txn = getTransaction(db, req.params.id, localDay(deps.now()));
      if (!txn) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (txn.forgiven) throw new ApiError(409, 'FORGIVENESS_LOCKED', 'delete the forgiveness to change it');
      if (!txn.splitLines.some((l) => l.id === req.params.lineId)) throw new ApiError(404, 'NOT_FOUND', 'split line not found');
      assertCategoryExists(db, body.categoryId, 'categoryId');
      assertPersonTaggable(db, body.personId, 'personId', txn.id);
      const sets: string[] = [];
      const args: unknown[] = [];
      // person and category are exclusive on a line, as on a transaction; a line's category never teaches
      if (body.categoryId !== undefined) {
        sets.push('category_id = ?');
        args.push(body.categoryId);
        if (body.categoryId !== null) sets.push('person_id = NULL');
      }
      if (body.personId !== undefined) {
        sets.push('person_id = ?');
        args.push(body.personId);
        if (body.personId !== null) sets.push('category_id = NULL');
      }
      if (body.payee !== undefined) { sets.push('payee = ?'); args.push(body.payee || null); }
      if (body.notes !== undefined) { sets.push('notes = ?'); args.push(body.notes); }
      db.prepare(`UPDATE split_lines SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.params.lineId);
      db.prepare('UPDATE transactions SET updated_at = ? WHERE id = ?').run(deps.now().toISOString(), txn.id);
      return { status: 200, body: getTransaction(db, txn.id, localDay(deps.now())) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/transactions', async (req, reply) => {
    const body = parseBody(CreateTransactionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      assertCategoryExists(db, body.categoryId, 'categoryId');
      const id = randomUUID();
      assertPersonTaggable(db, body.paidByPersonId, 'paidByPersonId', id, 'payer');
      assertPersonTaggable(db, body.personId, 'personId', id);
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO transactions (id, account_id, source, date, amount_cents, bank_description, payee, category_id, notes, paid_by_person_id,
          person_id, created_at, updated_at)
        VALUES (?, 'manual', 'manual', ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, body.date, body.amountCents, body.payee, body.categoryId ?? null, body.notes ?? null, body.paidByPersonId ?? null,
          body.personId ?? null, now, now);
      // one transaction with the row: a bad line rolls the row back too
      if (body.splitLines?.length) writeSplit(db, id, body.amountCents, body.splitLines, 'splitLines', now);
      return { status: 201, body: getTransaction(db, id, localDay(deps.now())) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete<{ Params: { id: string } }>('/v1/transactions/:id', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      const row = db.prepare('SELECT source FROM transactions WHERE id = ? AND removed_at IS NULL').get(req.params.id) as { source: string } | undefined;
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (row.source !== 'manual') throw new ApiError(409, 'BANK_TRANSACTION', 'only manual transactions can be deleted');
      restoreToInbox(db, req.params.id);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });
}
