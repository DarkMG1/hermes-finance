import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateJobBody, GrantBody, LinkPayStubBody, PatchGrantBody, PatchJobBody, PatchPayStubBody, PatchTaxFormBody, PayStubBody, PutProfileBody, TaxFormBody,
  TaxReturnBody } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { getForm, getGrant, getJob, getProfile, getReturn, getStub, listJobs, putProfile, stubMatches, taxYears } from '../profile.ts';
import { parseBody } from '../validate.ts';

const JOB_COLS = ['employer', 'title', 'status', 'start_date', 'end_date', 'base_cents', 'bonus_target_pct', 'signing_bonus_cents', 'relocation_cents', 'note'];
const GRANT_COLS = ['kind', 'shares', 'value_cents', 'strike_cents', 'grant_date', 'cliff_months', 'vest_months', 'vest_every_months'];
const jobValues = (j: CreateJobBody) => [j.employer, j.title ?? null, j.status, j.startDate ?? null, j.endDate ?? null, j.baseCents ?? null,
  j.bonusTargetPct ?? null, j.signingBonusCents ?? null, j.relocationCents ?? null, j.note ?? null];
const grantValues = (g: GrantBody) => [g.kind, g.shares ?? null, g.valueCents ?? null, g.strikeCents ?? null, g.grantDate, g.cliffMonths ?? 0, g.vestMonths, g.vestEveryMonths];
const assign = (cols: string[]) => cols.map((c) => `${c} = ?`).join(', ');
const pick = (o: object, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const STUB_COLS = ['job_id', 'pay_date', 'period_start', 'period_end', 'gross_cents', 'federal_cents', 'state_cents', 'social_security_cents', 'medicare_cents',
  'retirement_cents', 'other_deductions_cents', 'net_cents', 'ytd_gross_cents'];
const FORM_COLS = ['job_id', 'year', 'kind', 'payer', 'amount_cents', 'federal_withheld_cents', 'state', 'state_withheld_cents', 'ss_wages_cents', 'medicare_wages_cents'];
const RETURN_COLS = ['year', 'jurisdiction', 'filing_status', 'wages_cents', 'total_income_cents', 'agi_cents', 'deduction_kind', 'deduction_cents',
  'taxable_income_cents', 'total_tax_cents', 'credits_cents', 'withholding_cents', 'refund_cents', 'capital_gains_cents', 'capital_loss_carryover_cents'];
// left-out deduction lines are 0
const stubValues = (s: PayStubBody) => [s.jobId ?? null, s.payDate, s.periodStart ?? null, s.periodEnd ?? null, s.grossCents, s.federalCents ?? 0, s.stateCents ?? 0,
  s.socialSecurityCents ?? 0, s.medicareCents ?? 0, s.retirementCents ?? 0, s.otherDeductionsCents ?? 0, s.netCents, s.ytdGrossCents ?? null];
const formValues = (f: TaxFormBody) => [f.jobId ?? null, f.year, f.kind, f.payer, f.amountCents, f.federalWithheldCents ?? null, f.state ?? null,
  f.stateWithheldCents ?? null, f.ssWagesCents ?? null, f.medicareWagesCents ?? null];
const returnValues = (t: TaxReturnBody) => [t.year, t.jurisdiction, t.filingStatus ?? null, t.wagesCents ?? null, t.totalIncomeCents ?? null, t.agiCents ?? null,
  t.deductionKind ?? null, t.deductionCents ?? null, t.taxableIncomeCents ?? null, t.totalTaxCents ?? null, t.creditsCents ?? null, t.withholdingCents ?? null,
  t.refundCents ?? null, t.capitalGainsCents ?? null, t.capitalLossCarryoverCents ?? null];
const marks = (cols: string[]) => cols.map(() => '?').join(', ');

export function profileRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const today = () => localDay(deps.now());
  const job = (id: string) => {
    const j = getJob(db, id, today());
    if (!j) throw notFound('job');
    return j;
  };
  const assertJob = (id: string | null | undefined) => {
    if (id && !db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)) throw new ApiError(400, 'INVALID_REQUEST', 'jobId: unknown job', 'jobId');
  };
  const assertYear = (year: number) => {
    if (year > Number(today().slice(0, 4)) + 1) throw new ApiError(400, 'INVALID_REQUEST', 'year: must be at most next year', 'year');
  };
  const stub = (id: string) => {
    const s = getStub(db, id);
    if (!s) throw notFound('pay stub');
    return s;
  };
  const del = (table: string, what: string) => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id).changes) throw notFound(what);
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
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

  app.post('/v1/pay-stubs', async (req, reply) => {
    const body = parseBody(PayStubBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      assertJob(body.jobId);
      const id = randomUUID();
      db.prepare(`INSERT INTO pay_stubs (id, ${STUB_COLS.join(', ')}, created_at) VALUES (?, ${marks(STUB_COLS)}, ?)`).run(id, ...stubValues(body), deps.now().toISOString());
      return { status: 201, body: stub(id) };
    });
    return reply.code(r.status).send(r.body);
  });

  // an edit to net or pay date that the linked deposit no longer matches drops the link
  app.patch<{ Params: { id: string } }>('/v1/pay-stubs/:id', async (req, reply) => {
    const patch = parseBody(PatchPayStubBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = stub(req.params.id);
      const merged = parseBody(PayStubBody, { ...pick(current, Object.keys(PayStubBody.shape)), ...patch });
      assertJob(merged.jobId);
      db.prepare(`UPDATE pay_stubs SET ${assign(STUB_COLS)} WHERE id = ?`).run(...stubValues(merged), current.id);
      const s = stub(current.id);
      if (s.transactionId && (patch.netCents !== undefined || patch.payDate !== undefined) && !stubMatches(db, s, today()).some((t) => t.id === s.transactionId)) {
        db.prepare('UPDATE pay_stubs SET transaction_id = NULL WHERE id = ?').run(s.id);
      }
      return { status: 200, body: stub(s.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete('/v1/pay-stubs/:id', del('pay_stubs', 'pay stub'));
  app.get<{ Params: { id: string } }>('/v1/pay-stubs/:id/matches', async (req) => stubMatches(db, stub(req.params.id), today()));

  app.put<{ Params: { id: string } }>('/v1/pay-stubs/:id/link', async (req, reply) => {
    const { transactionId } = parseBody(LinkPayStubBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const s = stub(req.params.id);
      if (transactionId && !db.prepare('SELECT 1 FROM transactions WHERE id = ? AND removed_at IS NULL').get(transactionId)) {
        throw new ApiError(400, 'INVALID_REQUEST', 'transactionId: not a matching deposit', 'transactionId');
      }
      if (transactionId && db.prepare('SELECT 1 FROM pay_stubs WHERE transaction_id = ? AND id <> ?').get(transactionId, s.id)) {
        throw new ApiError(409, 'ALREADY_LINKED', 'that deposit is linked to another pay stub');
      }
      if (transactionId && !stubMatches(db, s, today()).some((t) => t.id === transactionId)) {
        throw new ApiError(400, 'INVALID_REQUEST', 'transactionId: not a matching deposit', 'transactionId');
      }
      db.prepare('UPDATE pay_stubs SET transaction_id = ? WHERE id = ?').run(transactionId, s.id);
      return { status: 200, body: stub(s.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/tax-forms', async (req, reply) => {
    const body = parseBody(TaxFormBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      assertYear(body.year);
      assertJob(body.jobId);
      const id = randomUUID();
      db.prepare(`INSERT INTO tax_forms (id, ${FORM_COLS.join(', ')}, created_at) VALUES (?, ${marks(FORM_COLS)}, ?)`).run(id, ...formValues(body), deps.now().toISOString());
      return { status: 201, body: getForm(db, id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.patch<{ Params: { id: string } }>('/v1/tax-forms/:id', async (req, reply) => {
    const patch = parseBody(PatchTaxFormBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = getForm(db, req.params.id);
      if (!current) throw notFound('tax form');
      const merged = parseBody(TaxFormBody, { ...pick(current, Object.keys(TaxFormBody.shape)), ...patch });
      assertYear(merged.year);
      assertJob(merged.jobId);
      db.prepare(`UPDATE tax_forms SET ${assign(FORM_COLS)} WHERE id = ?`).run(...formValues(merged), current.id);
      return { status: 200, body: getForm(db, current.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete('/v1/tax-forms/:id', del('tax_forms', 'tax form'));
  app.get('/v1/tax-years', async () => taxYears(db));

  app.put('/v1/tax-returns', async (req, reply) => {
    const body = parseBody(TaxReturnBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      assertYear(body.year);
      const now = deps.now().toISOString();
      db.prepare(`INSERT INTO tax_returns (id, ${RETURN_COLS.join(', ')}, created_at, updated_at) VALUES (?, ${marks(RETURN_COLS)}, ?, ?)
        ON CONFLICT (year, jurisdiction) DO UPDATE SET ${RETURN_COLS.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`)
        .run(randomUUID(), ...returnValues({ ...getReturn(db, body.year, body.jurisdiction), ...body }), now, now);
      return { status: 200, body: getReturn(db, body.year, body.jurisdiction) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.delete('/v1/tax-returns/:id', del('tax_returns', 'tax return'));
}
