import type { EquityGrant, Job, JobDetail, Profile, PutProfileBody, VestEvent } from '@hermes/shared';
import type { Db } from './db.ts';
import { addInterval } from './recurring.ts';

const PROFILE = `SELECT state, filing_status AS filingStatus, birth_year AS birthYear, dependents, retirement_pct AS retirementPct,
  retirement_kind AS retirementKind, hsa, note, updated_at AS updatedAt FROM profile WHERE id = 1`;
const JOB = `SELECT id, employer, title, status, start_date AS startDate, end_date AS endDate, base_cents AS baseCents,
  bonus_target_pct AS bonusTargetPct, signing_bonus_cents AS signingBonusCents, relocation_cents AS relocationCents, note,
  created_at AS createdAt, updated_at AS updatedAt FROM jobs`;
const GRANT = `SELECT id, job_id AS jobId, kind, shares, value_cents AS valueCents, strike_cents AS strikeCents, grant_date AS grantDate,
  cliff_months AS cliffMonths, vest_months AS vestMonths, vest_every_months AS vestEveryMonths FROM equity_grants`;

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
  return { ...job, grants, nextVests, stubs: [], forms: [] };
}

/** Vest events dated after `after`: the cliff vests everything accrued through it, then one event every vestEveryMonths, the last at
 *  vestMonths. Each event rounds down (whole shares, cents); the last takes the remainder. Month ends clamp (Jan 31 + 1 month = Feb 28). */
export function vestEvents(g: Pick<EquityGrant, 'id' | 'shares' | 'valueCents' | 'grantDate' | 'cliffMonths' | 'vestMonths' | 'vestEveryMonths'>, after: string, limit: number): VestEvent[] {
  const months = new Set<number>();
  if (g.cliffMonths > 0) months.add(g.cliffMonths);
  for (let m = g.vestEveryMonths; m < g.vestMonths; m += g.vestEveryMonths) if (m > g.cliffMonths) months.add(m);
  months.add(g.vestMonths);
  const sorted = [...months].sort((a, b) => a - b);
  const share = (total: number | null, prev: number, m: number, given: number) =>
    total === null ? null : m === g.vestMonths ? total - given : Math.floor((total * (m - prev)) / g.vestMonths);
  const events: VestEvent[] = [];
  let shares = 0;
  let cents = 0;
  sorted.forEach((m, i) => {
    const prev = i === 0 ? 0 : sorted[i - 1]!;
    const e = { date: addInterval(g.grantDate, 'monthly', m)!, shares: share(g.shares, prev, m, shares), valueCents: share(g.valueCents, prev, m, cents), grantId: g.id };
    shares += e.shares ?? 0;
    cents += e.valueCents ?? 0;
    if (e.date > after) events.push(e);
  });
  return events.slice(0, limit);
}
