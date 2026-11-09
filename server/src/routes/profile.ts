import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateJobBody, GrantBody, LinkPayStubBody, LotEntryBody, LotMethodBody, PatchGrantBody, PatchJobBody, PatchPayStubBody, PatchRothContributionBody, PatchTaxFormBody, PayStubBody, ProfileReadBody, PutProfileBody,
  RothContributionBody, StateW4Body, TaxFormBody, TaxInputsBody, TaxReturnBody, TaxScenarioBody, W4Body } from '@hermes/shared';
import type { Deps } from '../deps.ts';
import { localDay } from '../days.ts';
import { ApiError } from '../errors.ts';
import { idempotentWrite } from '../idempotency.ts';
import { readProfile } from '../profile-reader.ts';
import { getForm, getGrant, getJob, getProfile, getReturn, getStateW4, getStub, getW4, linkable, listJobs, putProfile, stubMatches, taxYears, unassignedStubs } from '../profile.ts';
import { getScenario, getTaxInputs, listRothContributions } from '../tax/inputs.ts';
import { buildLots } from '../tax/lots.ts';
import { assertOwnerDate, parseBody } from '../validate.ts';
import { isJpeg } from './receipts.ts';

/** up to 24 pages; the app shrinks them to fit */
const READ_MAX_BYTES = 8 * 1024 * 1024;

const JOB_COLS = ['employer', 'title', 'status', 'start_date', 'end_date', 'base_cents', 'monthly_cents', 'hourly_cents', 'hours_per_week', 'bonus_target_pct', 'signing_bonus_cents', 'relocation_cents', 'note'];
const GRANT_COLS = ['kind', 'shares', 'value_cents', 'strike_cents', 'grant_date', 'cliff_months', 'vest_months', 'vest_every_months'];
const jobValues = (j: CreateJobBody) => [j.employer, j.title ?? null, j.status, j.startDate ?? null, j.endDate ?? null, j.baseCents ?? null,
  j.monthlyCents ?? null, j.hourlyCents ?? null, j.hoursPerWeek ?? null, j.bonusTargetPct ?? null, j.signingBonusCents ?? null, j.relocationCents ?? null, j.note ?? null];
const grantValues = (g: GrantBody) => [g.kind, g.shares ?? null, g.valueCents ?? null, g.strikeCents ?? null, g.grantDate, g.cliffMonths ?? 0, g.vestMonths, g.vestEveryMonths];
const assign = (cols: string[]) => cols.map((c) => `${c} = ?`).join(', ');
const pick = (o: object, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const STUB_COLS = ['job_id', 'pay_date', 'period_start', 'period_end', 'gross_cents', 'federal_cents', 'state_cents', 'social_security_cents', 'medicare_cents',
  'retirement_cents', 'other_deductions_cents', 'other_pay_cents', 'net_cents', 'ytd_gross_cents', 'state'];
const FORM_COLS = ['job_id', 'year', 'kind', 'payer', 'amount_cents', 'federal_withheld_cents', 'state', 'state_withheld_cents', 'ss_wages_cents', 'medicare_wages_cents'];
const RETURN_COLS = ['year', 'jurisdiction', 'filing_status', 'wages_cents', 'total_income_cents', 'agi_cents', 'deduction_kind', 'deduction_cents',
  'taxable_income_cents', 'total_tax_cents', 'credits_cents', 'withholding_cents', 'refund_cents', 'capital_gains_cents', 'capital_loss_carryover_cents',
  'capital_loss_carryover_short_cents', 'capital_loss_carryover_long_cents', 'claimed_as_dependent'];
// left-out deduction lines and other pay are 0
const stubValues = (s: PayStubBody) => [s.jobId ?? null, s.payDate, s.periodStart ?? null, s.periodEnd ?? null, s.grossCents, s.federalCents ?? 0, s.stateCents ?? 0,
  s.socialSecurityCents ?? 0, s.medicareCents ?? 0, s.retirementCents ?? 0, s.otherDeductionsCents ?? 0, s.otherPayCents ?? 0, s.netCents, s.ytdGrossCents ?? null,
  s.state ?? null];
const formValues = (f: TaxFormBody) => [f.jobId ?? null, f.year, f.kind, f.payer, f.amountCents, f.federalWithheldCents ?? null, f.state ?? null,
  f.stateWithheldCents ?? null, f.ssWagesCents ?? null, f.medicareWagesCents ?? null];
const returnValues = (t: TaxReturnBody) => [t.year, t.jurisdiction, t.filingStatus ?? null, t.wagesCents ?? null, t.totalIncomeCents ?? null, t.agiCents ?? null,
  t.deductionKind ?? null, t.deductionCents ?? null, t.taxableIncomeCents ?? null, t.totalTaxCents ?? null, t.creditsCents ?? null, t.withholdingCents ?? null,
  t.refundCents ?? null, t.capitalGainsCents ?? null, t.capitalLossCarryoverCents ?? null,
  t.capitalLossCarryoverShortCents ?? null, t.capitalLossCarryoverLongCents ?? null,
  t.claimedAsDependent == null ? null : Number(t.claimedAsDependent)];
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
  /** owner-entered dates are bounded like every other one in Hermes */
  const assertDates = (o: object, keys: string[]) => keys.forEach((k) => assertOwnerDate((o as Record<string, string | null | undefined>)[k], today(), k));
  const JOB_DATES = ['startDate', 'endDate'];
  const STUB_DATES = ['payDate', 'periodStart', 'periodEnd'];
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
  // lets Settings show its row without loading any profile data before Face ID
  app.get('/v1/profile/exists', async () => ({ ok: true }));
  // no idempotency key: a read stores nothing
  app.post('/v1/profile/read', { bodyLimit: READ_MAX_BYTES }, async (req) => {
    const body = parseBody(ProfileReadBody, req.body);
    const pages = body.pages.map((p) => Buffer.from(p, 'base64'));
    const bad = pages.findIndex((p) => !isJpeg(p));
    if (bad >= 0) throw new ApiError(400, 'INVALID_IMAGE', `pages.${bad}: must be a JPEG`, `pages.${bad}`);
    const start = performance.now();
    try {
      return await readProfile(deps, body.kind, pages);
    } finally {
      const kb = Math.round(pages.reduce((n, p) => n + p.length, 0) / 1024);
      console.log(`[hermes] profile read kind=${body.kind} pages=${pages.length} kb=${kb} read_ms=${Math.round(performance.now() - start)}`);
    }
  });

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
    assertDates(body, JOB_DATES);
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
      assertDates(merged, JOB_DATES);
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
    assertDates(body, ['grantDate']);
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
      assertDates(merged, ['grantDate']);
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

  // replaces the job's W-4: only the latest one applies
  app.put<{ Params: { id: string } }>('/v1/jobs/:id/w4', async (req, reply) => {
    const w = parseBody(W4Body, req.body);
    assertDates(w, ['signedOn']);
    const r = idempotentWrite(deps, req, () => {
      job(req.params.id);
      const bit = (v: boolean | null | undefined) => (v == null ? null : Number(v));
      db.prepare(`INSERT OR REPLACE INTO w4s (job_id, signed_on, filing_status, multiple_jobs, dependents_cents, other_income_cents, deductions_cents,
        extra_withholding_cents, exempt, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.params.id, w.signedOn ?? null, w.filingStatus ?? null,
        bit(w.multipleJobs), w.dependentsCents ?? null, w.otherIncomeCents ?? null, w.deductionsCents ?? null, w.extraWithholdingCents ?? null, bit(w.exempt),
        deps.now().toISOString());
      return { status: 200, body: getW4(db, req.params.id) };
    });
    return reply.code(r.status).send(r.body);
  });
  app.delete<{ Params: { id: string } }>('/v1/jobs/:id/w4', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare('DELETE FROM w4s WHERE job_id = ?').run(req.params.id).changes) throw notFound('W-4');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });

  // replaces the job's form for that state
  app.put<{ Params: { id: string; state: string } }>('/v1/jobs/:id/state-w4/:state', async (req, reply) => {
    const { state } = req.params;
    if (!/^[A-Z]{2}$/.test(state)) throw new ApiError(400, 'INVALID_REQUEST', 'state: expected a 2-letter state code', 'state');
    const w = parseBody(StateW4Body, req.body);
    assertDates(w, ['signedOn']);
    const r = idempotentWrite(deps, req, () => {
      job(req.params.id);
      db.prepare(`INSERT OR REPLACE INTO state_w4s (job_id, state, signed_on, filing_status, allowances, additional_allowances, extra_withholding_cents, exempt,
        updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.params.id, state, w.signedOn ?? null, w.filingStatus ?? null, w.allowances ?? null,
        w.additionalAllowances ?? null, w.extraWithholdingCents ?? null, w.exempt == null ? null : Number(w.exempt), deps.now().toISOString());
      return { status: 200, body: getStateW4(db, req.params.id, state) };
    });
    return reply.code(r.status).send(r.body);
  });
  app.delete<{ Params: { id: string; state: string } }>('/v1/jobs/:id/state-w4/:state', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare('DELETE FROM state_w4s WHERE job_id = ? AND state = ?').run(req.params.id, req.params.state).changes) throw notFound('state form');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/pay-stubs', async (req, reply) => {
    const body = parseBody(PayStubBody, req.body);
    assertDates(body, STUB_DATES);
    const r = idempotentWrite(deps, req, () => {
      assertJob(body.jobId);
      // reading the same pay stubs twice (one PDF holds a whole run of them) shouldn't save them twice
      if (db.prepare('SELECT 1 FROM pay_stubs WHERE job_id IS ? AND pay_date = ? AND gross_cents = ? AND net_cents = ?')
        .get(body.jobId ?? null, body.payDate, body.grossCents, body.netCents)) throw new ApiError(409, 'DUPLICATE_STUB', 'this pay stub is already saved');
      const id = randomUUID();
      db.prepare(`INSERT INTO pay_stubs (id, ${STUB_COLS.join(', ')}, created_at) VALUES (?, ${marks(STUB_COLS)}, ?)`).run(id, ...stubValues(body), deps.now().toISOString());
      return { status: 201, body: stub(id) };
    });
    return reply.code(r.status).send(r.body);
  });

  // an edit to net or pay date that the linked deposits no longer match drops the links
  app.patch<{ Params: { id: string } }>('/v1/pay-stubs/:id', async (req, reply) => {
    const patch = parseBody(PatchPayStubBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const current = stub(req.params.id);
      const merged = parseBody(PayStubBody, { ...pick(current, Object.keys(PayStubBody.shape)), ...patch });
      assertDates(merged, STUB_DATES);
      assertJob(merged.jobId);
      db.prepare(`UPDATE pay_stubs SET ${assign(STUB_COLS)} WHERE id = ?`).run(...stubValues(merged), current.id);
      const s = stub(current.id);
      if (s.transactionIds.length && (patch.netCents !== undefined || patch.payDate !== undefined) && !linkable(db, s, s.transactionIds)) {
        db.prepare('DELETE FROM pay_stub_deposits WHERE stub_id = ?').run(s.id);
      }
      return { status: 200, body: stub(s.id) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get('/v1/pay-stubs/unassigned', async () => unassignedStubs(db));
  app.get<{ Params: { id: string } }>('/v1/pay-stubs/:id', async (req) => stub(req.params.id));
  app.delete('/v1/pay-stubs/:id', del('pay_stubs', 'pay stub'));
  app.get<{ Params: { id: string } }>('/v1/pay-stubs/:id/matches', async (req) => stubMatches(db, stub(req.params.id), today()));

  app.put<{ Params: { id: string } }>('/v1/pay-stubs/:id/link', async (req, reply) => {
    const { transactionIds: ids } = parseBody(LinkPayStubBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const s = stub(req.params.id);
      if (ids.some((id) => db.prepare(`SELECT 1 FROM pay_stub_deposits d JOIN transactions t ON t.id = d.transaction_id AND t.removed_at IS NULL
        WHERE d.transaction_id = ? AND d.stub_id <> ?`).get(id, s.id))) {
        throw new ApiError(409, 'ALREADY_LINKED', 'a deposit is linked to another pay stub');
      }
      if (ids.length && !linkable(db, s, ids)) {
        throw new ApiError(400, 'INVALID_REQUEST', 'transactionIds: not deposits that add up to the net', 'transactionIds');
      }
      db.prepare('DELETE FROM pay_stub_deposits WHERE stub_id = ?').run(s.id);
      const add = db.prepare('INSERT INTO pay_stub_deposits (stub_id, transaction_id) VALUES (?, ?)');
      for (const id of ids) add.run(s.id, id);
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

  const yearParam = (raw: string) => {
    const year = Number(raw);
    if (!Number.isInteger(year) || year < 2000) throw new ApiError(400, 'INVALID_REQUEST', 'year: expected a year from 2000', 'year');
    assertYear(year);
    return year;
  };
  type YearReq = FastifyRequest<{ Params: { year: string } }>;

  app.get<{ Params: { year: string } }>('/v1/tax/inputs/:year', async (req) => getTaxInputs(db, yearParam(req.params.year)));
  app.put('/v1/tax/inputs/:year', async (req: YearReq, reply) => {
    const year = yearParam(req.params.year);
    const b = parseBody(TaxInputsBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      db.prepare(`INSERT INTO tax_inputs (year, tuition_cents, scholarships_cents, student_loan_interest_cents, k401_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (year) DO UPDATE SET tuition_cents = excluded.tuition_cents, scholarships_cents = excluded.scholarships_cents,
          student_loan_interest_cents = excluded.student_loan_interest_cents, k401_cents = excluded.k401_cents, updated_at = excluded.updated_at`)
        .run(year, b.tuitionCents ?? null, b.scholarshipsCents ?? null, b.studentLoanInterestCents ?? null, b.k401Cents ?? null, deps.now().toISOString());
      return { status: 200, body: getTaxInputs(db, year) };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get<{ Params: { year: string } }>('/v1/tax/scenario/:year', async (req) => getScenario(db, yearParam(req.params.year)));
  app.put('/v1/tax/scenario/:year', async (req: YearReq, reply) => {
    const year = yearParam(req.params.year);
    const b = parseBody(TaxScenarioBody, req.body);
    if (b.moveDate && Number(b.moveDate.slice(0, 4)) !== year) throw new ApiError(400, 'INVALID_REQUEST', 'moveDate: must be within the year', 'moveDate');
    const r = idempotentWrite(deps, req, () => {
      db.prepare(`INSERT INTO tax_scenarios (year, move_date, move_to, relocation_cents, bonus_cents, k401_cents, roth_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (year) DO UPDATE SET move_date = excluded.move_date, move_to = excluded.move_to, relocation_cents = excluded.relocation_cents,
          bonus_cents = excluded.bonus_cents, k401_cents = excluded.k401_cents, roth_cents = excluded.roth_cents, updated_at = excluded.updated_at`)
        .run(year, b.moveDate ?? null, b.moveTo ?? null, b.relocationCents ?? null, b.bonusCents ?? null, b.k401Cents ?? null, b.rothCents ?? null, deps.now().toISOString());
      return { status: 200, body: getScenario(db, year) };
    });
    return reply.code(r.status).send(r.body);
  });

  // a contribution counts for its deposit year, or the year before when deposited Jan 1 to Apr 15
  const assertRothYear = (date: string, taxYear: number) => {
    const y = Number(date.slice(0, 4));
    if (taxYear !== y && !(taxYear === y - 1 && date.slice(5) <= '04-15')) {
      throw new ApiError(400, 'INVALID_REQUEST', 'taxYear: must be the deposit year, or the year before for a deposit from Jan 1 to Apr 15', 'taxYear');
    }
  };
  app.get<{ Querystring: { taxYear?: string } }>('/v1/tax/roth-contributions', async (req) => {
    const taxYear = Number(req.query.taxYear);
    if (!Number.isInteger(taxYear) || taxYear < 2000) throw new ApiError(400, 'INVALID_REQUEST', 'taxYear: expected a year from 2000', 'taxYear');
    return { contributions: listRothContributions(db, taxYear) };
  });
  app.post('/v1/tax/roth-contributions', async (req, reply) => {
    const b = parseBody(RothContributionBody, req.body);
    assertDates(b, ['date']);
    assertRothYear(b.date, b.taxYear);
    const r = idempotentWrite(deps, req, () => {
      const id = randomUUID();
      db.prepare('INSERT INTO roth_contributions (id, date, amount_cents, tax_year) VALUES (?, ?, ?, ?)').run(id, b.date, b.amountCents, b.taxYear);
      return { status: 201, body: { id, date: b.date, amountCents: b.amountCents, taxYear: b.taxYear, transactionId: null } };
    });
    return reply.code(r.status).send(r.body);
  });
  app.put<{ Params: { id: string } }>('/v1/tax/roth-contributions/:id', async (req, reply) => {
    const { taxYear } = parseBody(PatchRothContributionBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      const row = db.prepare('SELECT date FROM roth_contributions WHERE id = ? AND dismissed = 0').get(req.params.id) as { date: string } | undefined;
      if (!row) throw notFound('Roth contribution');
      assertRothYear(row.date, taxYear);
      db.prepare('UPDATE roth_contributions SET tax_year = ? WHERE id = ?').run(taxYear, req.params.id);
      return { status: 200, body: db.prepare('SELECT id, date, amount_cents AS amountCents, tax_year AS taxYear, transaction_id AS transactionId FROM roth_contributions WHERE id = ?').get(req.params.id) };
    });
    return reply.code(r.status).send(r.body);
  });
  app.delete<{ Params: { id: string } }>('/v1/tax/roth-contributions/:id', async (req, reply) => {
    const r = idempotentWrite(deps, req, () => {
      // a suggested row is kept as dismissed so the next list doesn't suggest it again
      const changes = db.prepare('UPDATE roth_contributions SET dismissed = 1 WHERE id = ? AND transaction_id IS NOT NULL AND dismissed = 0').run(req.params.id).changes
        || db.prepare('DELETE FROM roth_contributions WHERE id = ? AND transaction_id IS NULL').run(req.params.id).changes;
      if (!changes) throw notFound('Roth contribution');
      return { status: 200, body: { ok: true } };
    });
    return reply.code(r.status).send(r.body);
  });

  app.get('/v1/tax/lots', async () => buildLots(db, today()));
  app.post('/v1/tax/lots', async (req, reply) => {
    const b = parseBody(LotEntryBody, req.body);
    assertDates(b, ['acquiredOn']);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND type = 'investment'").get(b.accountId)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'accountId: unknown investment account', 'accountId');
    }
    if (!db.prepare('SELECT 1 FROM securities WHERE id = ?').get(b.securityId)) throw new ApiError(400, 'INVALID_REQUEST', 'securityId: unknown security', 'securityId');
    const r = idempotentWrite(deps, req, () => {
      const id = randomUUID();
      db.prepare('INSERT INTO lot_entries (id, account_id, security_id, acquired_on, quantity, cost_cents) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, b.accountId, b.securityId, b.acquiredOn, b.quantity, b.costCents);
      return { status: 201, body: { id, ...b } };
    });
    return reply.code(r.status).send(r.body);
  });
  app.delete('/v1/tax/lots/:id', del('lot_entries', 'lot'));
  app.patch<{ Params: { id: string } }>('/v1/accounts/:id/lot-method', async (req, reply) => {
    const { method } = parseBody(LotMethodBody, req.body);
    const r = idempotentWrite(deps, req, () => {
      if (!db.prepare("UPDATE accounts SET lot_method = ? WHERE id = ? AND type = 'investment'").run(method, req.params.id).changes) throw notFound('investment account');
      return { status: 200, body: { accountId: req.params.id, method } };
    });
    return reply.code(r.status).send(r.body);
  });
}
