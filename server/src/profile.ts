import type { EquityGrant, Job, JobDetail, PayStub, PayStubMatches, Profile, PutProfileBody, StateW4, TaxForm, TaxReturn, TaxYears, VestEvent, W4 } from '@hermes/shared';
import type { Db } from './db.ts';
import { lookups, rowToTransaction, TXN_COLS, type TxnRow } from './ledger.ts';
import { addInterval, memberships } from './recurring.ts';

const PROFILE = `SELECT state, filing_status AS filingStatus, birth_year AS birthYear, dependents, retirement_pct AS retirementPct,
  retirement_kind AS retirementKind, hsa, note, full_time_student AS fullTimeStudent, claimed_as_dependent AS claimedAsDependent,
  updated_at AS updatedAt FROM profile WHERE id = 1`;
const JOB = `SELECT id, employer, title, status, start_date AS startDate, end_date AS endDate, base_cents AS baseCents, monthly_cents AS monthlyCents, hourly_cents AS hourlyCents, hours_per_week AS hoursPerWeek,
  bonus_target_pct AS bonusTargetPct, signing_bonus_cents AS signingBonusCents, relocation_cents AS relocationCents, note,
  created_at AS createdAt, updated_at AS updatedAt FROM jobs`;
const GRANT = `SELECT id, job_id AS jobId, kind, shares, value_cents AS valueCents, strike_cents AS strikeCents, grant_date AS grantDate,
  cliff_months AS cliffMonths, vest_months AS vestMonths, vest_every_months AS vestEveryMonths FROM equity_grants`;

// a deposit Plaid removed is no longer linked (a pending one's stub moves to the posted row in sync)
const STUB = `SELECT id, job_id AS jobId, pay_date AS payDate, period_start AS periodStart, period_end AS periodEnd, gross_cents AS grossCents,
  federal_cents AS federalCents, state_cents AS stateCents, social_security_cents AS socialSecurityCents, medicare_cents AS medicareCents,
  retirement_cents AS retirementCents, other_deductions_cents AS otherDeductionsCents, other_pay_cents AS otherPayCents, net_cents AS netCents,
  ytd_gross_cents AS ytdGrossCents, state, (SELECT json_group_array(t.id ORDER BY t.date, t.id) FROM pay_stub_deposits d JOIN transactions t ON t.id = d.transaction_id
    AND t.removed_at IS NULL WHERE d.stub_id = pay_stubs.id) AS transactionIds, created_at AS createdAt FROM pay_stubs`;
const stubRows = (rows: unknown[]): PayStub[] =>
  (rows as (Omit<PayStub, 'transactionIds'> & { transactionIds: string })[]).map((r) => ({ ...r, transactionIds: JSON.parse(r.transactionIds) as string[] }));
const FORM = `SELECT id, job_id AS jobId, year, kind, payer, amount_cents AS amountCents, federal_withheld_cents AS federalWithheldCents, state,
  state_withheld_cents AS stateWithheldCents, ss_wages_cents AS ssWagesCents, medicare_wages_cents AS medicareWagesCents, created_at AS createdAt FROM tax_forms`;
const W4_SELECT = `SELECT job_id AS jobId, signed_on AS signedOn, filing_status AS filingStatus, multiple_jobs AS multipleJobs, dependents_cents AS dependentsCents,
  other_income_cents AS otherIncomeCents, deductions_cents AS deductionsCents, extra_withholding_cents AS extraWithholdingCents, exempt, updated_at AS updatedAt
  FROM w4s WHERE job_id = ?`;
const flag = (v: unknown) => (v === null ? null : v === 1);
const bit = (v: boolean | null) => (v === null ? null : Number(v));
export function getW4(db: Db, jobId: string): W4 | null {
  const w = db.prepare(W4_SELECT).get(jobId) as (W4 & { multipleJobs: unknown; exempt: unknown }) | undefined;
  return w ? { ...w, multipleJobs: flag(w.multipleJobs), exempt: flag(w.exempt) } : null;
}
const STATE_W4 = `SELECT job_id AS jobId, state, signed_on AS signedOn, filing_status AS filingStatus, allowances, additional_allowances AS additionalAllowances,
  extra_withholding_cents AS extraWithholdingCents, exempt, updated_at AS updatedAt FROM state_w4s`;
const stateW4Rows = (rows: unknown[]): StateW4[] => (rows as (StateW4 & { exempt: unknown })[]).map((w) => ({ ...w, exempt: flag(w.exempt) }));
export const getStateW4 = (db: Db, jobId: string, state: string): StateW4 | undefined =>
  stateW4Rows(db.prepare(`${STATE_W4} WHERE job_id = ? AND state = ?`).all(jobId, state))[0];
const RETURN = `SELECT id, year, jurisdiction, filing_status AS filingStatus, wages_cents AS wagesCents, total_income_cents AS totalIncomeCents,
  agi_cents AS agiCents, deduction_kind AS deductionKind, deduction_cents AS deductionCents, taxable_income_cents AS taxableIncomeCents,
  total_tax_cents AS totalTaxCents, credits_cents AS creditsCents, withholding_cents AS withholdingCents, refund_cents AS refundCents,
  capital_gains_cents AS capitalGainsCents, capital_loss_carryover_cents AS capitalLossCarryoverCents, claimed_as_dependent AS claimedAsDependent,
  created_at AS createdAt, updated_at AS updatedAt FROM tax_returns`;
const returnRows = (rows: unknown[]): TaxReturn[] => (rows as (TaxReturn & { claimedAsDependent: unknown })[]).map((r) => ({ ...r, claimedAsDependent: flag(r.claimedAsDependent) }));

export const getStub = (db: Db, id: string): PayStub | undefined => stubRows(db.prepare(`${STUB} WHERE id = ?`).all(id))[0];
export const unassignedStubs = (db: Db): PayStub[] => stubRows(db.prepare(`${STUB} WHERE job_id IS NULL ORDER BY pay_date DESC, created_at DESC, id`).all());
export const getForm = (db: Db, id: string) => db.prepare(`${FORM} WHERE id = ?`).get(id) as TaxForm | undefined;
export const getReturn = (db: Db, year: number, jurisdiction: string) =>
  returnRows(db.prepare(`${RETURN} WHERE year = ? AND jurisdiction = ?`).all(year, jurisdiction))[0];

const candidates = (db: Db, stub: PayStub) => db.prepare(`SELECT ${TXN_COLS} FROM transactions WHERE removed_at IS NULL AND amount_cents > 0
    AND amount_cents <= @net AND account_id IN (SELECT id FROM accounts WHERE type = 'depository') AND abs(julianday(date) - julianday(@day)) <= 3
    AND NOT EXISTS (SELECT 1 FROM pay_stub_deposits d WHERE d.transaction_id = transactions.id AND d.stub_id <> @id)
    -- a pending deposit whose posted row is already here is the same money
    AND NOT (pending = 1 AND EXISTS (SELECT 1 FROM transactions p WHERE p.source = 'plaid' AND p.pending_source_id = transactions.source_id AND p.removed_at IS NULL))
  ORDER BY abs(julianday(date) - julianday(@day)), date DESC, id`).all({ net: stub.netCents, day: stub.payDate, id: stub.id }) as TxnRow[];

/** Bank-account deposits within 3 days of the stub's pay date, at most its net, that no other stub holds (closest first, then newest),
 *  with the single deposits and the pairs that add up to the net. */
export function stubMatches(db: Db, stub: PayStub, today: string): PayStubMatches {
  const rows = candidates(db, stub);
  const l = lookups(db, rows, memberships(db, today));
  const suggestions = rows.filter((r) => r.amount_cents === stub.netCents).map((r) => [r.id]);
  rows.forEach((a, i) => rows.slice(i + 1).forEach((b) => { if (a.amount_cents + b.amount_cents === stub.netCents) suggestions.push([a.id, b.id]); }));
  return { deposits: rows.map((r) => rowToTransaction(r, l)), suggestions };
}

/** Distinct candidate deposits that add up to the stub's net exactly. */
export function linkable(db: Db, stub: PayStub, ids: string[]): boolean {
  const amounts = new Map(candidates(db, stub).map((r) => [r.id, r.amount_cents]));
  return new Set(ids).size === ids.length && ids.every((id) => amounts.has(id)) && ids.reduce((n, id) => n + amounts.get(id)!, 0) === stub.netCents;
}

export function taxYears(db: Db): TaxYears {
  const returns = returnRows(db.prepare(`${RETURN} ORDER BY year DESC, jurisdiction <> 'federal', jurisdiction`).all());
  const forms = db.prepare(`${FORM} ORDER BY year DESC, payer, id`).all() as TaxForm[];
  return { years: [...new Set([...returns, ...forms].map((x) => x.year))].sort((a, b) => b - a).map((year) => {
    const fed = returns.find((r) => r.year === year && r.jurisdiction === 'federal');
    const rate = fed && fed.totalTaxCents !== null && (fed.totalIncomeCents ?? 0) > 0 ? Math.round((fed.totalTaxCents / fed.totalIncomeCents!) * 10000) / 10000 : null;
    return { year, returns: returns.filter((r) => r.year === year), forms: forms.filter((f) => f.year === year), effectiveRate: rate };
  }) };
}

const SUMS = { grossCents: 'gross_cents', federalCents: 'federal_cents', stateCents: 'state_cents', socialSecurityCents: 'social_security_cents',
  medicareCents: 'medicare_cents', retirementCents: 'retirement_cents', otherDeductionsCents: 'other_deductions_cents', otherPayCents: 'other_pay_cents',
  netCents: 'net_cents' } as const satisfies Partial<Record<keyof PayStub, string>>;

/** Stubs in the range (newest first) with year-to-date totals: for each job and calendar year among them, every stub of that job
 *  that year from Jan 1 through the latest returned pay date, whatever `from` is. */
export function payStubs(db: Db, q: { from?: string; to?: string; jobId?: string }) {
  const stubs = stubRows(db.prepare(`${STUB} WHERE (@from IS NULL OR pay_date >= @from) AND (@to IS NULL OR pay_date <= @to) AND (@jobId IS NULL OR job_id = @jobId)
    ORDER BY pay_date DESC, created_at DESC, id`).all({ from: q.from ?? null, to: q.to ?? null, jobId: q.jobId ?? null }));
  const latest = new Map<string, { jobId: string | null; year: number; through: string }>();
  for (const s of stubs) {
    const key = `${s.jobId}|${s.payDate.slice(0, 4)}`;
    if (!latest.has(key)) latest.set(key, { jobId: s.jobId, year: Number(s.payDate.slice(0, 4)), through: s.payDate });
  }
  const sums = Object.entries(SUMS).map(([k, c]) => `SUM(${c}) AS ${k}`).join(', ');
  const sum = db.prepare(`SELECT ${sums} FROM pay_stubs WHERE job_id IS @jobId AND pay_date >= @start AND pay_date <= @through`);
  const ytd = [...latest.values()].map((g) => {
    const totals = sum.get({ jobId: g.jobId, start: `${g.year}-01-01`, through: g.through }) as Record<keyof typeof SUMS, number>;
    return { jobId: g.jobId, year: g.year, ...totals };
  }).sort((a, b) => a.year - b.year || (a.jobId ?? '').localeCompare(b.jobId ?? ''));
  return { stubs, ytd };
}

export function getProfile(db: Db): Profile {
  const p = db.prepare(PROFILE).get() as Profile & Record<'hsa' | 'fullTimeStudent' | 'claimedAsDependent', unknown>;
  return { ...p, hsa: flag(p.hsa), fullTimeStudent: flag(p.fullTimeStudent), claimedAsDependent: flag(p.claimedAsDependent) };
}

export function putProfile(db: Db, body: PutProfileBody, nowIso: string): Profile {
  const p = { ...getProfile(db), ...body };
  db.prepare(`UPDATE profile SET state = ?, filing_status = ?, birth_year = ?, dependents = ?, retirement_pct = ?, retirement_kind = ?,
      hsa = ?, note = ?, full_time_student = ?, claimed_as_dependent = ?, updated_at = ? WHERE id = 1`)
    .run(p.state, p.filingStatus, p.birthYear, p.dependents, p.retirementPct, p.retirementKind, bit(p.hsa), p.note, bit(p.fullTimeStudent), bit(p.claimedAsDependent), nowIso);
  return getProfile(db);
}

export function listJobs(db: Db): Job[] {
  return db.prepare(`${JOB} ORDER BY created_at DESC, id`).all() as Job[];
}

export const getGrant = (db: Db, jobId: string, id: string) => db.prepare(`${GRANT} WHERE job_id = ? AND id = ?`).get(jobId, id) as EquityGrant | undefined;

export function getJob(db: Db, id: string, today: string): JobDetail | null {
  const job = db.prepare(`${JOB} WHERE id = ?`).get(id) as Job | undefined;
  if (!job) return null;
  const grants = db.prepare(`${GRANT} WHERE job_id = ? ORDER BY grant_date, id`).all(id) as EquityGrant[];
  // a declined offer never vests; nothing vests after the job ends
  const nextVests = job.status === 'declined' ? [] : grants.flatMap((g) => vestEvents(g, today, 4)).filter((e) => !job.endDate || e.date <= job.endDate)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const stubs = stubRows(db.prepare(`${STUB} WHERE job_id = ? ORDER BY pay_date DESC, created_at DESC, id`).all(id));
  const forms = db.prepare(`${FORM} WHERE job_id = ? ORDER BY year DESC, payer, id`).all(id) as TaxForm[];
  return { ...job, grants, nextVests, stubs, forms, w4: getW4(db, id), stateW4s: stateW4Rows(db.prepare(`${STATE_W4} WHERE job_id = ? ORDER BY state`).all(id)) };
}

/** Vest events dated after `after`: the cliff vests everything accrued through it, then one event every vestEveryMonths counted from the
 *  cliff, the last at vestMonths. Each event vests what has accrued so far rounded down (whole shares, cents); the last takes the remainder;
 *  an event that vests nothing is left out. Month ends clamp (Jan 31 + 1 month = Feb 28). */
export function vestEvents(g: Pick<EquityGrant, 'id' | 'shares' | 'valueCents' | 'grantDate' | 'cliffMonths' | 'vestMonths' | 'vestEveryMonths'>, after: string, limit: number): VestEvent[] {
  const months = new Set<number>();
  if (g.cliffMonths > 0) months.add(g.cliffMonths);
  for (let m = g.cliffMonths + g.vestEveryMonths; m < g.vestMonths; m += g.vestEveryMonths) months.add(m);
  months.add(g.vestMonths);
  const sorted = [...months].sort((a, b) => a - b);
  const share = (total: number | null, m: number, given: number) =>
    total === null ? null : m === g.vestMonths ? total - given : Math.floor((total * m) / g.vestMonths) - given;
  const events: VestEvent[] = [];
  let shares = 0;
  let cents = 0;
  sorted.forEach((m) => {
    const e = { date: addInterval(g.grantDate, 'monthly', m)!, shares: share(g.shares, m, shares), valueCents: share(g.valueCents, m, cents), grantId: g.id };
    shares += e.shares ?? 0;
    cents += e.valueCents ?? 0;
    if (e.date > after && ((e.shares ?? 0) > 0 || (e.valueCents ?? 0) > 0)) events.push(e);
  });
  return events.slice(0, limit);
}
