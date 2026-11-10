import type { JobDetail, PayStub, TaxScenario } from '@hermes/shared';
import { addDays } from '../days.ts';
import { vestEvents } from '../profile.ts';
import { addInterval } from '../recurring.ts';
import { bracketTax } from './federal.ts';
import type { FederalFigures } from './figures.ts';

export type Paycheck = {
  date: string; grossCents: number; federalCents: number; stateCents: number; state: string | null; estimated: true;
  /** what was assumed to get this check (same text on every check it applies to) */
  assumption: string;
};
export type PayContext = {
  figures: FederalFigures;
  /** the year's scenario when this job is the one it describes (bonus, relocation); else null */
  scenario: TaxScenario | null;
  /** the state lived in on a date */
  stateOn: (date: string) => string | null;
  /** a state's tax on a year of these wages alone (null: no figures for it) */
  stateTax: (code: string, annualCents: number) => number | null;
  stateSupplementalRate: (code: string) => number | null;
  /** the share of gross pay deferred pre-tax to a 401(k): an estimated W-4 withholds on the rest */
  deferralShare?: number;
};

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

/** IRS percentage method (Pub 15-T, 2020+ W-4) on a year of wages: the W-4's steps, or a standard W-4 without one. */
function w4Tax(job: JobDetail, annualCents: number, periods: number, f: FederalFigures): number {
  // shortcut: ignores FICA and other pre-tax deductions, as the projection's wages do
  const w = job.w4;
  if (w?.exempt) return 0;
  const status = w?.filingStatus === 'married_joint' ? 'marriedJoint' : 'single';
  // step 2's box: half the standard deduction and half-width brackets
  const half = w?.multipleJobs ? 2 : 1;
  const sd = (w?.filingStatus === 'head_of_household' ? f.standardDeduction.headOfHousehold : f.standardDeduction[status]) / half;
  const taxable = Math.max(0, annualCents + (w?.otherIncomeCents ?? 0) - (w?.deductionsCents ?? 0) - sd);
  const brackets = f.brackets[status].map(([top, rate]) => [top === null ? null : top / half, rate] as [number | null, number]);
  return Math.max(0, bracketTax(taxable, brackets) - (w?.dependentsCents ?? 0)) + (w?.extraWithholdingCents ?? 0) * periods;
}

/**
 * A job's paychecks in `year` not on a stub yet: every pay period after its latest stub (or from its start date when it has none)
 * through its end date, at the latest stub's gross (else the recorded yearly, monthly or hourly pay) and the last 3 stubs' withholding
 * rates (else a percentage-method estimate). A job starting after today is also paid its relocation and signing bonus on its start date;
 * the scenario's job its bonus in December; every job its RSU vests. Those are withheld at the supplemental rates.
 */
export function futurePaychecks(job: JobDetail, stubs: PayStub[], year: number, today: string, ctx: PayContext): Paycheck[] {
  if (job.status === 'declined' || job.status === 'past') return [];
  const start = `${year}-01-01`;
  const end = job.endDate && job.endDate < `${year}-12-31` ? job.endDate : `${year}-12-31`;
  const name = job.employer;
  const sorted = stubs.toSorted((a, b) => a.payDate.localeCompare(b.payDate));
  const last = sorted.at(-1);
  // of two stubs under 7 days apart, one is off-cycle (a bonus or stipend run): the one whose gross is further from the usual pay sets neither
  // the cadence, the schedule, the gross nor the withholding rates
  const usual = sorted.length ? median(sorted.map((s) => s.grossCents)) : 0;
  const onCycle: PayStub[] = [];
  for (const s of sorted) {
    const prev = onCycle.at(-1);
    if (!prev || days(prev.payDate, s.payDate) >= 7) onCycle.push(s);
    else if (Math.abs(s.grossCents - usual) <= Math.abs(prev.grossCents - usual)) onCycle[onCycle.length - 1] = s;
  }
  const gaps = onCycle.slice(1).map((s, i) => days(onCycle[i]!.payDate, s.payDate));
  const gap = gaps.length ? median(gaps) : !last && job.baseCents === null && job.monthlyCents !== null ? 30 : 14;
  const monthly = gap >= 28;
  // 15- or 16-day gaps: paid twice a month on the last two stubs' days of the month (28 or later is the month's end)
  const semi = !monthly && gap >= 15 && gap <= 16 && onCycle.length >= 2 ? onCycle.slice(-2).map((s) => Number(s.payDate.slice(8))).map((d) => (d >= 28 ? 31 : d)) : null;
  const periods = monthly ? 12 : semi ? 24 : Math.round(365 / gap);
  const gross = last ? median(onCycle.slice(-3).map((s) => s.grossCents)) : (job.baseCents !== null ? Math.round(job.baseCents / 26) : job.monthlyCents
    ?? (job.hourlyCents !== null && job.hoursPerWeek !== null ? Math.round(job.hourlyCents * job.hoursPerWeek * 2) : 0));
  const annual = gross * periods;
  // a job with stubs keeps its stubs' state; a new job pays where the owner lives
  const stateOf = (date: string) => (last ? last.state : ctx.stateOn(date));

  const recent = onCycle.filter((s) => s.grossCents > 0).slice(-3);
  const avg = (part: (s: PayStub) => number) => recent.reduce((a, s) => a + part(s) / s.grossCents, 0) / recent.length;
  const fedRate = recent.length ? avg((s) => s.federalCents)
    : annual ? w4Tax(job, Math.round(annual * (1 - (ctx.deferralShare ?? 0))), periods, ctx.figures) / annual : 0;
  const stateRate = (code: string | null) => (recent.length ? avg((s) => s.stateCents) : code && annual ? (ctx.stateTax(code, annual) ?? 0) / annual : 0);
  const check = (date: string, grossCents: number, fed: number, state: number, assumption: string): Paycheck =>
    ({ date, grossCents, federalCents: Math.round(grossCents * fed), stateCents: Math.round(grossCents * state), state: stateOf(date), estimated: true, assumption });

  const notes = [`${name}: future paychecks ${last ? 'at the median gross of the last 3 stubs' : 'from the recorded pay'}, every ${monthly ? 'month' : semi ? 'half month' : `${gap} days`}${gaps.length ? '' : ' (assumed)'} through ${end}`];
  if (!recent.length) notes.push(`Estimated withholding: ${job.w4 ? 'from its W-4' : 'a standard W-4'} by the IRS percentage method${ctx.deferralShare ? ', after pre-tax 401(k)' : ''}`);
  else notes.push(`${name}: withholding at the last 3 stubs' rates (at their 401(k) contributions)`);
  const out: Paycheck[] = [];
  if (gross > 0) {
    const anchor = onCycle.at(-1)?.payDate ?? job.startDate ?? today;
    if (!last && !job.startDate) notes.push(`${name}: no start date or pay stubs, so pay before ${today} isn't counted`);
    const twice = (k: number) => {
      const [y, m] = anchor.split('-').map(Number) as [number, number];
      const month = new Date(Date.UTC(y, m - 1 + Math.floor((k - 1) / 2), 1));
      const eom = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      const days2 = semi!.toSorted((a, b) => a - b).map((d) => Math.min(d, eom));
      return `${month.toISOString().slice(0, 8)}${String(days2[(k - 1) % 2]!).padStart(2, '0')}`;
    };
    for (let k = 1; ; k++) {
      const date = monthly ? addInterval(anchor, 'monthly', k)! : semi ? twice(k) : addDays(anchor, gap * k);
      if (semi && date <= anchor) continue;
      if (date > end || k > 1000) break;
      if (date < start) continue;
      const code = stateOf(date);
      if (!recent.length && code && ctx.stateTax(code, annual) === null) notes.push(`No ${code} figures: state withholding not estimated`);
      out.push(check(date, gross, fedRate, stateRate(code), ''));
    }
  } else if (!last) {
    out.push(check(end, 0, 0, 0, `${name}: no pay recorded, so no paychecks counted`));
  }
  const regular = [...new Set(notes)].join('; ');
  for (const c of out) c.assumption ||= regular;

  const supplemental = (date: string, cents: number | null, what: string) => {
    if (!cents || date <= today || date < start || date > end) return;
    const code = stateOf(date);
    out.push(check(date, cents, ctx.figures.supplementalRate, code ? ctx.stateSupplementalRate(code) ?? stateRate(code) : 0,
      `${name}: ${what}, withheld at the supplemental rate`));
  };
  if (job.startDate) {
    const s = ctx.scenario?.relocationCents ?? null;
    supplemental(job.startDate, s ?? job.relocationCents, `relocation ${s === null ? 'as recorded on the job' : 'from the scenario'} paid on the start date`);
    supplemental(job.startDate, job.signingBonusCents, 'signing bonus paid on the start date');
  }
  if (ctx.scenario) {
    const s = ctx.scenario.bonusCents;
    const target = job.bonusTargetPct !== null && job.baseCents !== null ? Math.round(job.baseCents * job.bonusTargetPct / 100) : null;
    supplemental(`${year}-12-15`, s ?? target, `bonus ${s === null ? 'at the target' : 'from the scenario'} paid in December`);
  }
  for (const g of job.grants.filter((x) => x.kind === 'rsu')) {
    for (const v of vestEvents(g, today > `${year - 1}-12-31` ? today : `${year - 1}-12-31`, 1000)) {
      if (v.valueCents === null && v.date <= end) out.push(check(v.date, 0, 0, 0, `${name}: an RSU vest on ${v.date} has no value recorded, so it isn't counted`));
      else supplemental(v.date, v.valueCents, "RSU vests valued at the grant's value");
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
