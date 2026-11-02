import type { EquityGrant, Job, JobDetail, PayStub, Profile, PutProfileBody, TaxForm, TaxReturn, TaxYears, Transaction, VestEvent } from '@hermes/shared';
import type { Db } from './db.ts';
import { lookups, rowToTransaction, TXN_COLS, type TxnRow } from './ledger.ts';
import { addInterval, memberships } from './recurring.ts';

const PROFILE = `SELECT state, filing_status AS filingStatus, birth_year AS birthYear, dependents, retirement_pct AS retirementPct,
  retirement_kind AS retirementKind, hsa, note, updated_at AS updatedAt FROM profile WHERE id = 1`;
const JOB = `SELECT id, employer, title, status, start_date AS startDate, end_date AS endDate, base_cents AS baseCents,
  bonus_target_pct AS bonusTargetPct, signing_bonus_cents AS signingBonusCents, relocation_cents AS relocationCents, note,
  created_at AS createdAt, updated_at AS updatedAt FROM jobs`;
const GRANT = `SELECT id, job_id AS jobId, kind, shares, value_cents AS valueCents, strike_cents AS strikeCents, grant_date AS grantDate,
  cliff_months AS cliffMonths, vest_months AS vestMonths, vest_every_months AS vestEveryMonths FROM equity_grants`;

// a deposit Plaid removed is no longer linked (a pending one's stub moves to the posted row in sync)
const STUB = `SELECT id, job_id AS jobId, pay_date AS payDate, period_start AS periodStart, period_end AS periodEnd, gross_cents AS grossCents,
  federal_cents AS federalCents, state_cents AS stateCents, social_security_cents AS socialSecurityCents, medicare_cents AS medicareCents,
  retirement_cents AS retirementCents, other_deductions_cents AS otherDeductionsCents, net_cents AS netCents, ytd_gross_cents AS ytdGrossCents,
  CASE WHEN EXISTS (SELECT 1 FROM transactions t WHERE t.id = transaction_id AND t.removed_at IS NULL) THEN transaction_id END AS transactionId,
  created_at AS createdAt FROM pay_stubs`;
const FORM = `SELECT id, job_id AS jobId, year, kind, payer, amount_cents AS amountCents, federal_withheld_cents AS federalWithheldCents, state,
  state_withheld_cents AS stateWithheldCents, ss_wages_cents AS ssWagesCents, medicare_wages_cents AS medicareWagesCents, created_at AS createdAt FROM tax_forms`;
const RETURN = `SELECT id, year, jurisdiction, filing_status AS filingStatus, wages_cents AS wagesCents, total_income_cents AS totalIncomeCents,
  agi_cents AS agiCents, deduction_kind AS deductionKind, deduction_cents AS deductionCents, taxable_income_cents AS taxableIncomeCents,
  total_tax_cents AS totalTaxCents, credits_cents AS creditsCents, withholding_cents AS withholdingCents, refund_cents AS refundCents,
  capital_gains_cents AS capitalGainsCents, capital_loss_carryover_cents AS capitalLossCarryoverCents, created_at AS createdAt, updated_at AS updatedAt
  FROM tax_returns`;

export const getStub = (db: Db, id: string) => db.prepare(`${STUB} WHERE id = ?`).get(id) as PayStub | undefined;
export const getForm = (db: Db, id: string) => db.prepare(`${FORM} WHERE id = ?`).get(id) as TaxForm | undefined;
export const getReturn = (db: Db, year: number, jurisdiction: string) =>
  db.prepare(`${RETURN} WHERE year = ? AND jurisdiction = ?`).get(year, jurisdiction) as TaxReturn | undefined;

/** Deposits of exactly the stub's net within 3 days of its pay date that no other stub holds; closest first, then newest. */
export function stubMatches(db: Db, stub: PayStub, today: string): Transaction[] {
  const rows = db.prepare(`SELECT ${TXN_COLS} FROM transactions WHERE removed_at IS NULL AND amount_cents > 0 AND amount_cents = @net
      AND abs(julianday(date) - julianday(@day)) <= 3 AND NOT EXISTS (SELECT 1 FROM pay_stubs s WHERE s.transaction_id = transactions.id AND s.id <> @id)
    ORDER BY abs(julianday(date) - julianday(@day)), date DESC, id`).all({ net: stub.netCents, day: stub.payDate, id: stub.id }) as TxnRow[];
  const l = lookups(db, rows, memberships(db, today));
  return rows.map((r) => rowToTransaction(r, l));
}

export function taxYears(db: Db): TaxYears {
  const returns = db.prepare(`${RETURN} ORDER BY year DESC, jurisdiction <> 'federal', jurisdiction`).all() as TaxReturn[];
  const forms = db.prepare(`${FORM} ORDER BY year DESC, payer, id`).all() as TaxForm[];
  return { years: [...new Set([...returns, ...forms].map((x) => x.year))].sort((a, b) => b - a).map((year) => {
    const fed = returns.find((r) => r.year === year && r.jurisdiction === 'federal');
    const rate = fed && fed.totalTaxCents !== null && (fed.totalIncomeCents ?? 0) > 0 ? Math.round((fed.totalTaxCents / fed.totalIncomeCents!) * 10000) / 10000 : null;
    return { year, returns: returns.filter((r) => r.year === year), forms: forms.filter((f) => f.year === year), effectiveRate: rate };
  }) };
}

const SUMS = ['grossCents', 'federalCents', 'stateCents', 'socialSecurityCents', 'medicareCents', 'retirementCents', 'otherDeductionsCents', 'netCents'] as const;

/** Stubs in the range (newest first) with their totals per job and calendar year of pay date. */
export function payStubs(db: Db, q: { from?: string; to?: string; jobId?: string }) {
  const stubs = db.prepare(`${STUB} WHERE (@from IS NULL OR pay_date >= @from) AND (@to IS NULL OR pay_date <= @to) AND (@jobId IS NULL OR job_id = @jobId)
    ORDER BY pay_date DESC, created_at DESC, id`).all({ from: q.from ?? null, to: q.to ?? null, jobId: q.jobId ?? null }) as PayStub[];
  const groups = new Map<string, { jobId: string | null; year: number } & Record<(typeof SUMS)[number], number>>();
  for (const s of stubs) {
    const year = Number(s.payDate.slice(0, 4));
    const key = `${s.jobId}|${year}`;
    if (!groups.has(key)) groups.set(key, { jobId: s.jobId, year, ...Object.fromEntries(SUMS.map((k) => [k, 0])) } as never);
    for (const k of SUMS) groups.get(key)![k] += s[k];
  }
  return { stubs, ytd: [...groups.values()].sort((a, b) => a.year - b.year || (a.jobId ?? '').localeCompare(b.jobId ?? '')) };
}

export function getProfile(db: Db): Profile {
  const p = db.prepare(PROFILE).get() as Omit<Profile, 'hsa'> & { hsa: number | null };
  return { ...p, hsa: p.hsa === null ? null : p.hsa === 1 };
}

export function putProfile(db: Db, body: PutProfileBody, nowIso: string): Profile {
  const p = { ...getProfile(db), ...body };
  db.prepare(`UPDATE profile SET state = ?, filing_status = ?, birth_year = ?, dependents = ?, retirement_pct = ?, retirement_kind = ?,
      hsa = ?, note = ?, updated_at = ? WHERE id = 1`)
    .run(p.state, p.filingStatus, p.birthYear, p.dependents, p.retirementPct, p.retirementKind, p.hsa === null ? null : Number(p.hsa), p.note, nowIso);
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
  const nextVests = grants.flatMap((g) => vestEvents(g, today, 4)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const stubs = db.prepare(`${STUB} WHERE job_id = ? ORDER BY pay_date DESC, created_at DESC, id`).all(id) as PayStub[];
  const forms = db.prepare(`${FORM} WHERE job_id = ? ORDER BY year DESC, payer, id`).all(id) as TaxForm[];
  return { ...job, grants, nextVests, stubs, forms };
}

/** Vest events dated after `after`: the cliff vests everything accrued through it, then one event every vestEveryMonths, the last at
 *  vestMonths. Each event vests what has accrued so far rounded down (whole shares, cents); the last takes the remainder. Month ends clamp (Jan 31 + 1 month = Feb 28). */
export function vestEvents(g: Pick<EquityGrant, 'id' | 'shares' | 'valueCents' | 'grantDate' | 'cliffMonths' | 'vestMonths' | 'vestEveryMonths'>, after: string, limit: number): VestEvent[] {
  const months = new Set<number>();
  if (g.cliffMonths > 0) months.add(g.cliffMonths);
  for (let m = g.vestEveryMonths; m < g.vestMonths; m += g.vestEveryMonths) if (m > g.cliffMonths) months.add(m);
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
    if (e.date > after) events.push(e);
  });
  return events.slice(0, limit);
}
