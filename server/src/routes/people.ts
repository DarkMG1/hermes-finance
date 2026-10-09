import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CreatePersonBody, ListPeopleQuery, PatchPersonBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { parseBody } from '../validate.ts';
import { idempotentWrite } from '../idempotency.ts';
import { getPerson, listPeople, suggestions } from '../people.ts';

export function peopleRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/v1/people', async (req) => listPeople(db, parseBody(ListPeopleQuery, req.query).all === '1'));

  app.get('/v1/people/suggestions', async () => suggestions(db, deps.now()));

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
