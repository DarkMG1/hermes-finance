import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CreateRecurringBody, PatchRecurringBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { getTransaction } from '../ledger.ts';
import { localDay } from '../networth.ts';
import { getRecurring, normalizeName } from '../recurring.ts';
import { parseBody } from '../validate.ts';

export function recurringRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const today = () => localDay(deps.now());
  // inside the write, so a stream that went inactive (or a manual item with no live charge) rolls back as 404
  const find = (id: string) => {
    const item = getRecurring(db, today(), true).items.find((i) => i.id === id);
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'recurring item not found');
    return item;
  };

  app.get<{ Querystring: { hidden?: string } }>('/v1/recurring', async (req) => getRecurring(db, today(), req.query.hidden === '1'));

  app.patch<{ Params: { id: string } }>('/v1/recurring/:id', async (req, reply) => {
    const body = parseBody(PatchRecurringBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const id = req.params.id;
      if (db.prepare('SELECT 1 FROM recurring_streams WHERE stream_id = ?').get(id)) {
        db.prepare('INSERT OR IGNORE INTO recurring_overrides (stream_id) VALUES (?)').run(id);
        if (body.hidden !== undefined) db.prepare('UPDATE recurring_overrides SET hidden = ? WHERE stream_id = ?').run(body.hidden ? 1 : 0, id);
        if (body.name !== undefined) db.prepare('UPDATE recurring_overrides SET name = ? WHERE stream_id = ?').run(body.name, id);
        if (body.frequency !== undefined) db.prepare('UPDATE recurring_overrides SET frequency = ? WHERE stream_id = ?').run(body.frequency, id);
      } else if (db.prepare('SELECT 1 FROM recurring_manual WHERE id = ?').get(id)) {
        if (body.hidden !== undefined) db.prepare('UPDATE recurring_manual SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, id);
        if (body.name) db.prepare('UPDATE recurring_manual SET name = ? WHERE id = ?').run(body.name, id);
        if (body.frequency !== undefined) db.prepare('UPDATE recurring_manual SET frequency = ? WHERE id = ?').run(body.frequency, id);
      } else {
        throw new ApiError(404, 'NOT_FOUND', 'recurring item not found');
      }
      return { status: 200, body: find(id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/recurring', async (req, reply) => {
    const body = parseBody(CreateRecurringBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const t = getTransaction(db, body.transactionId);
      if (!t) throw new ApiError(404, 'NOT_FOUND', 'transaction not found');
      if (t.amountCents >= 0) throw new ApiError(409, 'NOT_MONEY_OUT', 'only money out can recur');
      const matchText = normalizeName(t.payee);
      if (!matchText) throw new ApiError(409, 'NO_NAME', 'this charge has no name to match');
      const keys = [
        ...(db.prepare('SELECT match_text AS k FROM recurring_manual WHERE hidden = 0').all() as { k: string }[]).map((r) => r.k),
        ...(db.prepare(`SELECT s.name, o.name AS o_name FROM recurring_streams s LEFT JOIN recurring_overrides o ON o.stream_id = s.stream_id
            WHERE s.is_active = 1 AND s.status != 'tombstoned' AND COALESCE(o.hidden, 0) = 0`).all() as { name: string; o_name: string | null }[])
          .flatMap((r) => [r.name, r.o_name ?? r.name].map(normalizeName)),
      ];
      if (keys.includes(matchText)) {
        throw new ApiError(409, 'ALREADY_RECURRING', 'this is already recurring');
      }
      const id = randomUUID();
      db.prepare('INSERT INTO recurring_manual (id, name, match_text, frequency, source_transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, body.name ?? t.payee, matchText, body.frequency, t.id, deps.now().toISOString());
      return { status: 201, body: find(id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete<{ Params: { id: string } }>('/v1/recurring/:id', async (req, reply) => {
    if (db.prepare('SELECT 1 FROM recurring_streams WHERE stream_id = ?').get(req.params.id)) {
      throw new ApiError(409, 'PLAID_RECURRING', 'hide a recurring item Plaid found instead of deleting it');
    }
    db.prepare('DELETE FROM recurring_manual WHERE id = ?').run(req.params.id);
    return reply.code(204).send();
  });
}
