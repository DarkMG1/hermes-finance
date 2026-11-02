import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CreateJobBody, GrantBody, PatchGrantBody, PatchJobBody, PutProfileBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { getGrant, getJob, getProfile, listJobs, putProfile } from '../profile.ts';
import { parseBody } from '../validate.ts';

const JOB_COLS = ['employer', 'title', 'status', 'start_date', 'end_date', 'base_cents', 'bonus_target_pct', 'signing_bonus_cents', 'relocation_cents', 'note'];
const GRANT_COLS = ['kind', 'shares', 'value_cents', 'strike_cents', 'grant_date', 'cliff_months', 'vest_months', 'vest_every_months'];
const jobValues = (j: CreateJobBody) => [j.employer, j.title ?? null, j.status, j.startDate ?? null, j.endDate ?? null, j.baseCents ?? null,
  j.bonusTargetPct ?? null, j.signingBonusCents ?? null, j.relocationCents ?? null, j.note ?? null];
const grantValues = (g: GrantBody) => [g.kind, g.shares ?? null, g.valueCents ?? null, g.strikeCents ?? null, g.grantDate, g.cliffMonths ?? 0, g.vestMonths, g.vestEveryMonths];
const assign = (cols: string[]) => cols.map((c) => `${c} = ?`).join(', ');
const pick = (o: object, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

export function profileRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const today = () => localDay(deps.now());
  const job = (id: string) => {
    const j = getJob(db, id, today());
    if (!j) throw notFound('job');
    return j;
  };

  app.get('/v1/profile', async () => getProfile(db));

  app.put('/v1/profile', async (req, reply) => {
    const body = parseBody(PutProfileBody, req.body);
    if (body.birthYear && body.birthYear > Number(today().slice(0, 4))) throw new ApiError(400, 'INVALID_REQUEST', 'birthYear: must not be in the future', 'birthYear');
    const r = idempotentWrite(deps, req, () => ({ status: 200, body: putProfile(db, body, deps.now().toISOString()) }));
    return reply.code(r.status).send(r.body);
  });

  app.get('/v1/jobs', async () => listJobs(db));
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req) => job(req.params.id));

  app.post('/v1/jobs', async (req, reply) => {
    const body = parseBody(CreateJobBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const id = randomUUID();
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO jobs (id, ${JOB_COLS.join(', ')}, created_at, updated_at) VALUES (?, ${JOB_COLS.map(() => '?').join(', ')}, ?, ?)`)
        .run(id, ...jobValues(body), now, now);
      return { status: 201, body: job(id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.patch<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const patch = parseBody(PatchJobBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = job(req.params.id);
      const merged = parseBody(CreateJobBody, { ...pick(current, Object.keys(CreateJobBody.shape)), ...patch });
      db.prepare(`UPDATE jobs SET ${assign(JOB_COLS)}, updated_at = ? WHERE id = ?`).run(...jobValues(merged), deps.now().toISOString(), current.id);
      return { status: 200, body: job(current.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id).changes) throw notFound('job');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/grants', async (req, reply) => {
    const body = parseBody(GrantBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      job(req.params.id);
      const id = randomUUID();
      db.prepare(`INSERT INTO equity_grants (id, job_id, ${GRANT_COLS.join(', ')}) VALUES (?, ?, ${GRANT_COLS.map(() => '?').join(', ')})`)
        .run(id, req.params.id, ...grantValues(body));
      return { status: 201, body: getGrant(db, req.params.id, id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.patch<{ Params: { id: string; grantId: string } }>('/v1/jobs/:id/grants/:grantId', async (req, reply) => {
    const patch = parseBody(PatchGrantBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = getGrant(db, req.params.id, req.params.grantId);
      if (!current) throw notFound('grant');
      const { id, jobId } = current;
      const merged = parseBody(GrantBody, { ...pick(current, Object.keys(GrantBody.shape)), ...(patch.kind === 'rsu' ? { strikeCents: null } : {}), ...patch });
      db.prepare(`UPDATE equity_grants SET ${assign(GRANT_COLS)} WHERE id = ?`).run(...grantValues(merged), id);
      return { status: 200, body: getGrant(db, jobId, id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete<{ Params: { id: string; grantId: string } }>('/v1/jobs/:id/grants/:grantId', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare('DELETE FROM equity_grants WHERE job_id = ? AND id = ?').run(req.params.id, req.params.grantId).changes) throw notFound('grant');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });
}
