import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreatePersonBody, ForgiveBody, ListPeopleQuery, PatchPersonBody, PeopleSettings } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { assertCategoryExists, getTransaction } from '../ledger.ts';
import { getPerson, listPeople, peopleSettings, suggestions } from '../people.ts';

export function peopleRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/v1/people', async (req) => listPeople(db, parseBody(ListPeopleQuery, req.query).all === '1'));

  app.get('/v1/people/suggestions', async () => suggestions(db, deps.now()));

  app.post<{ Params: { id: string } }>('/v1/people/suggestions/:id/dismiss', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      const res = db.prepare('UPDATE transactions SET repayment_dismissed = 1, updated_at = ? WHERE id = ? AND removed_at IS NULL')
        .run(deps.now().toISOString(), req.params.id);
      if (!res.changes) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/v1/people/:id/forgive', async (req, reply) => {
    const body = parseBody(ForgiveBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const detail = getPerson(db, req.params.id);
      if (!detail) throw new ApiError(404, 'NOT_FOUND', 'person not found');
      const owed = detail.person.balanceCents;
      if (owed <= 0) throw new ApiError(409, 'NOTHING_OWED', "they don't owe you anything");
      if (body.amountCents > owed) throw new ApiError(400, 'INVALID_REQUEST', 'amountCents: more than they owe', 'amountCents');
      let categoryId = body.categoryId ?? null;
      if (categoryId) {
        assertCategoryExists(db, categoryId, 'categoryId');
        const c = db.prepare('SELECT is_income, is_transfer FROM categories WHERE id = ?').get(categoryId) as { is_income: number; is_transfer: number };
        if (c.is_income || c.is_transfer) throw new ApiError(400, 'INVALID_REQUEST', 'categoryId: pick a spending category', 'categoryId');
      } else {
        categoryId = (db.prepare("SELECT id FROM categories WHERE name = 'Gifts'").pluck().get() as string | undefined) ?? randomUUID();
        db.prepare("INSERT OR IGNORE INTO categories (id, name, group_name) VALUES (?, 'Gifts', 'Gifts')").run(categoryId);
      }
      const id = randomUUID();
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO transactions (id, account_id, source, date, amount_cents, bank_description, payee, notes, forgiven, created_at, updated_at)
        VALUES (?, 'manual', 'manual', ?, 0, '', ?, ?, 1, ?, ?)`).run(id, body.date, `Forgave ${detail.person.name}`, body.notes ?? null, now, now);
      // opposite-sign lines on a $0 row: writeSplit's same-sign check would refuse them
      const line = db.prepare('INSERT INTO split_lines (id, transaction_id, amount_cents, category_id, person_id) VALUES (?, ?, ?, ?, ?)');
      line.run(`00-${randomUUID()}`, id, body.amountCents, null, req.params.id);
      line.run(`01-${randomUUID()}`, id, -body.amountCents, categoryId, null);
      return { status: 201, body: getTransaction(db, id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get('/v1/people/settings', async () => peopleSettings(db));

  app.put('/v1/people/settings', async (req, reply) => {
    const body = parseBody(PeopleSettings, req.body);
    const r = idempotentWrite(deps, req, () => {
      if (body.repaymentAccountId === null) {
        db.prepare("DELETE FROM settings WHERE key = 'repayment_account_id'").run();
      } else {
        if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type = 'depository'").get(body.repaymentAccountId)) {
          throw new ApiError(400, 'INVALID_REQUEST', 'repaymentAccountId: not a bank account', 'repaymentAccountId');
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('repayment_account_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(body.repaymentAccountId);
      }
      return { status: 200, body: peopleSettings(db) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get<{ Params: { id: string } }>('/v1/people/:id', async (req) => {
    const detail = getPerson(db, req.params.id);
    if (!detail) throw new ApiError(404, 'NOT_FOUND', 'person not found');
    return detail;
  });

  app.post('/v1/people', async (req, reply) => {
    const body = parseBody(CreatePersonBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const id = randomUUID();
      db.prepare('INSERT INTO people (id, name, match_text, created_at) VALUES (?, ?, ?, ?)')
        .run(id, body.name, body.matchText ?? null, deps.now().toISOString());
      return { status: 201, body: getPerson(db, id)!.person };
    });
    return reply.code(r.status).send(r.body);
  });

  app.patch<{ Params: { id: string } }>('/v1/people/:id', async (req, reply) => {
    const body = parseBody(PatchPersonBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = getPerson(db, req.params.id);
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'person not found');
      if (body.archived && current.person.balanceCents !== 0) {
        throw new ApiError(409, 'PERSON_HAS_BALANCE', 'archive a person once they are settled up', 'archived');
      }
      const sets: string[] = [];
      const args: unknown[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name); }
      if (body.matchText !== undefined) { sets.push('match_text = ?'); args.push(body.matchText); }
      if (body.archived !== undefined) { sets.push('archived = ?'); args.push(body.archived ? 1 : 0); }
      db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.params.id);
      return { status: 200, body: getPerson(db, req.params.id)!.person };
    });
    return reply.code(r.status).send(r.body);
  });
}
