import type { TaxScenario } from '@hermes/shared';
import { addDays } from '../days.ts';
import type { Deps } from '../deps.ts';
import { getJob, getProfile, getReturn, listJobs, payStubs } from '../profile.ts';
import { advise, usd } from './advice.ts';
import { computeFederal } from './federal.ts';
import { federalFigures, stateFigures } from './figures.ts';
import { getScenario, getTaxInputs } from './inputs.ts';
import { buildLots, planSales, SHELTERED, type Sale } from './lots.ts';
import { futurePaychecks, type Paycheck } from './paychecks.ts';
import { computeState, type Residency, type StateInput } from './state.ts';
import type { ReturnResult, TaxProjection, WhatIf } from './types.ts';

export type { TaxProjection, WhatIf };

/** Until Apr 15 last year is still open (unfiled; Roth contributions still count for it). */
export function openYears(today: string): number[] {
  const y = Number(today.slice(0, 4));
  return today.slice(5) <= '04-15' ? [y - 1, y, y + 1] : [y, y + 1];
}

const PAYOUT = 'dividend';
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What a year's returns cost after refundable credits: savings compare this, so a withholding change can't look like a saving. */
export const liability = (returns: ReturnResult[]) => sum(returns.filter((r) => r.supported), (r) => r.withheldCents - r.balanceCents);
const CARRIED: Record<string, string> = { ira: 'IRA limit', rothPhaseOut: 'Roth income limits', k401Limit: '401(k) limit' };

type Options = { advice?: boolean; harvest?: boolean };
const METHOD = { fifo: 'FIFO', hifo: 'highest cost first', specific: 'specific lots' } as const;

/** Advice is computed only for the plain projection (no change), and never inside its own what-ifs; `harvest: false` skips the sale what-ifs. */
function assemble(deps: Deps, year: number, today: string, change: WhatIf = {}, opts: Options = {}) {
  const { db } = deps;
  const notes: string[] = [];
  const note = (s: string) => { if (!notes.includes(s)) notes.push(s); };
  const thisYear = Number(today.slice(0, 4));
  const future = year > thisYear;
  const start = `${year}-01-01`, end = `${year}-12-31`;

  // Who and where
  const profile = getProfile(db);
  const home = profile.state;
  const filingStatus = profile.filingStatus ?? 'single';
  if (!profile.filingStatus) note('No filing status in the profile: single assumed');
  if (profile.claimedAsDependent === null) note('Dependent status not set: assumes no one can claim you');
  if (profile.fullTimeStudent === null) note('Student status not set: assumes not a full-time student');
  if (future) note('Student and dependent status: assumes the same as this year');
  const claimable = profile.claimedAsDependent ?? false;
  const stored = getScenario(db, year);
  const merged = { ...stored, ...change.scenario };
  const scenario: TaxScenario | null = future ? merged : null;
  // the move counts in any year (it stays editable once its year starts); the scenario's other inputs are next year's only
  const move = merged.moveDate && merged.moveTo ? { date: merged.moveDate, to: merged.moveTo } : null;
  const residency: Residency = [
    ...(home && (!move || move.date > start) ? [{ code: home, from: start, to: move ? addDays(move.date, -1) : end }] : []),
    ...(move ? [{ code: move.to, from: move.date, to: end }] : []),
  ];
  if (move) note(`Scenario: moving to ${move.to} on ${move.date}`);
  if (!home) note(move ? 'No home state in the profile: no resident state return before the move'
    : 'No home state in the profile: no resident state return; pay is taxed only where it was earned');
  const others = (o: object) => Object.entries(o).some(([k, v]) => k !== 'moveDate' && k !== 'moveTo' && k !== 'year' && k !== 'updatedAt' && v !== null && v !== undefined);
  if (!future && (others(stored) || (change.scenario && others(change.scenario)))) {
    note(`Scenario pay and contribution inputs apply to next year only: ignored for ${year}`);
  }
  const stateOn = (date: string) => residency.find((p) => p.from <= date && date <= p.to)?.code ?? null;

  // Figures
  const fed = federalFigures(year);
  if (fed.fallback) note(`${fed.year} federal figures used for ${year} until published`);
  for (const g of fed.figures.carriedFrom2026 ?? []) note(`${year} ${CARRIED[g]}: 2026 amounts used until published`);
  const models = new Map<string, ReturnType<typeof stateFigures>>();
  const modelOf = (code: string) => {
    if (!models.has(code)) {
      const m = stateFigures(deps.config.stateTaxFile, year, code);
      if (m?.fallback) note(`${m.year} ${code} figures used for ${year} until published`);
      models.set(code, m);
    }
    return models.get(code)!;
  };
  const stateInput = (code: string, items: StateInput['incomeByPeriod'], withheldCents: number, otherStateTaxCents: number): StateInput =>
    ({ code, residency, incomeByPeriod: items, totalIncomeCents: sum(items, (i) => i.wagesCents + i.investmentCents), claimable, withheldCents, otherStateTaxCents });

  // Owner inputs: blank is 0, said so
  const inputs = getTaxInputs(db, year);
  const blank = (v: number | null, msg: string) => { if (v === null) note(msg); return v ?? 0; };

  // Pay: stubs so far (with any earlier pay their year-to-date shows), then the future paychecks of current and accepted jobs (and any job paid
  // this year); the scenario's bonus and relocation go to the job starting latest
  const inYear = (s: { payDate: string }) => s.payDate >= start && s.payDate <= end;
  const allJobs = listJobs(db).map((j) => getJob(db, j.id, today)!);
  const jobs = allJobs.filter((j) => j.status === 'current' || j.status === 'accepted' || j.stubs.some(inYear));
  const offers = allJobs.filter((j) => j.status === 'offered' && !jobs.includes(j));
  if (offers.length) note(`Offers not accepted are not counted: ${offers.map((j) => j.employer).join(', ')}`);
  const scenarioJob = jobs.filter((j) => j.status !== 'declined' && j.status !== 'past').sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
  const stubs = payStubs(db, { from: start, to: end }).stubs;
  const assigned = stubs.filter((s) => s.jobId !== null);
  if (stubs.length > assigned.length) note(`${plural(stubs.length - assigned.length, 'pay stub')} not assigned to a job: not counted`);
  const earlier: (Omit<Paycheck, 'estimated'> & { earlier: true })[] = [];
  for (const j of jobs) {
    const mine = assigned.filter((s) => s.jobId === j.id).sort((a, b) => a.payDate.localeCompare(b.payDate));
    const last = mine.at(-1);
    const gap = (last?.ytdGrossCents ?? 0) - sum(mine, (s) => s.grossCents);
    if (!last || gap <= 0) continue;
    earlier.push({ date: mine[0]!.payDate, grossCents: gap, federalCents: 0, stateCents: 0, state: last.state, earlier: true,
      assumption: `${j.employer}: ${usd(gap)} earlier pay not in Hermes (from the stub's year-to-date); its withholding isn't counted` });
  }
  for (const e of earlier) note(e.assumption);
  const paychecks = (deferralShare: number) => jobs.flatMap((j) => futurePaychecks(j, j.stubs, year, today, {
    figures: fed.figures, scenario: j === scenarioJob ? scenario : null, stateOn, deferralShare,
    stateTax: (code, annual) => {
      const m = modelOf(code);
      return m && computeState({ ...stateInput(code, [{ wagesCents: annual, investmentCents: 0, sourceState: code, date: start }], 0, 0),
        residency: [{ code, from: start, to: end }] }, m.model).taxCents;
    },
    stateSupplementalRate: (code) => modelOf(code)?.model.supplementalRate ?? null,
  }));
  let projected = paychecks(0);
  const gross = sum(assigned, (s) => s.grossCents) + sum(earlier, (e) => e.grossCents) + sum(projected, (p) => p.grossCents);
  const k401 = Math.min(gross, blank(future ? scenario!.k401Cents : inputs.k401Cents, `No 401(k) contributions entered for ${year}`));
  // pre-tax 401(k) lowers the wages a W-4 withholds on
  if (k401) projected = paychecks(k401 / gross);
  for (const p of projected) note(p.assumption);
  if (!future && jobs.some((j) => j.bonusTargetPct)) note('Bonuses not paid yet this year are not projected');
  const pay = [...assigned.map((s) => ({ ...s, date: s.payDate })), ...earlier, ...projected].map((p) => {
    if (p.state || p.grossCents === 0) return p;
    note(home ? `Pay stub state not recorded; counted as ${home}` : 'Pay with no state recorded and no home state: its state tax is not counted');
    return { ...p, state: home };
  });
  if (!gross) note(`No pay stubs or jobs paying in ${year}: no wages counted`);
  else note('Other pre-tax deductions (health insurance, HSA) are not taken off wages');

  const tuitionCents = blank(inputs.tuitionCents, 'No tuition entered: education credit not counted');
  const scholarshipsCents = blank(inputs.scholarshipsCents, 'No scholarships entered');
  const studentLoanInterestCents = blank(inputs.studentLoanInterestCents, 'No student loan interest entered');

  // Investment income in taxable accounts (next year: this year's again, same dates): dividends and short-term capital gain distributions are
  // ordinary dividends, long-term distributions long-term gains, interest interest
  const incomeYear = future ? thisYear : year;
  const cash = (db.prepare(`SELECT t.date, -t.amount_cents AS cents, lower(t.subtype) AS kind, a.subtype FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.type = 'investment' AND t.type = 'cash' AND (lower(t.subtype) LIKE ? OR lower(t.subtype) = 'interest' OR lower(t.subtype) LIKE '%capital gain%')
      AND t.date BETWEEN ? AND ?`)
    .all(`%${PAYOUT}%`, `${incomeYear}-01-01`, `${incomeYear}-12-31`) as { date: string; cents: number; kind: string; subtype: string | null }[])
    .filter((d) => !SHELTERED.has((d.subtype ?? '').toLowerCase())).map((d) => ({ date: `${year}${d.date.slice(4)}`, cents: d.cents, kind: d.kind }));
  const longDist = cash.filter((d) => d.kind.includes('capital gain') && d.kind.includes('long'));
  const interest = cash.filter((d) => d.kind === 'interest');
  const divs = cash.filter((d) => !longDist.includes(d) && !interest.includes(d));
  if (divs.length) note('Dividends counted as ordinary until the 1099-DIV shows the qualified part');
  if (cash.some((d) => d.kind.includes('capital gain'))) note('Capital gain distributions: long-term counted as long-term gains, short-term as ordinary dividends');
  const divTotal = sum(divs, (d) => d.cents);
  const divNote = future ? `Next year's dividends = this year's so far (${usd(divTotal)} through ${today})` : null;
  if (divNote) note(divNote);
  else if (year === thisYear) note(`Dividends after ${today} not projected`);
  if (future && (interest.length || longDist.length)) note(`Next year's interest and capital gain distributions = this year's so far (through ${today})`);
  note('Bank interest not included');

  const lots = buildLots(db, today);
  for (const m of lots.mismatched) note(`${m.ticker ?? m.securityId}: the trade history adds up to more shares than are held, so its lots are unverified`);
  const planned = change.sell?.length
    ? year < thisYear ? { sales: [], blocked: `${year} is over: a sale now counts in ${thisYear}`, washedBySold: false } : planSales(db, lots, change.sell, future ? start : today)
    : { sales: [], blocked: null, washedBySold: false };
  for (const s of change.sell ?? []) {
    const method = lots.methods[s.accountId] ?? 'fifo';
    if (s.lotIds?.length && method !== 'specific') note(`Lots chosen ignored: account matches by ${METHOD[method]}`);
  }
  if (planned.blocked) note(`Proposed sale not counted: ${planned.blocked}`);
  else if (planned.sales.length) {
    note(`Proposed sale on ${planned.sales[0]!.date} at the last synced price; a buy of the same security in the 30 days after would wash a loss`);
    if (future) note(`Sale counted on Jan 1 of ${year} for the holding period`);
    if (planned.washedBySold) note('Shares bought in the 30 days before and already sold count as wash-sale replacements: the disallowed loss would move to that earlier sale');
  }
  const sales = [...lots.sales.filter((s) => s.date >= start && s.date <= end), ...planned.sales];
  const unknown = sales.filter((s) => s.taxable && s.term === 'unknown').length;
  if (unknown) note(`${plural(unknown, 'sale')} of shares bought before the trade history: cost unknown — enter their cost on the Tax screen`);

  // last year: its return, else its projection while it hasn't happened yet (carryover, and the safe harbor's prior-year tax)
  const prior = getReturn(db, year - 1, 'federal');
  const priorProjection = !prior && year - 1 >= thisYear ? assemble(deps, year - 1, today, {}, { advice: false }) : null;
  let carryover = { shortCents: 0, longCents: 0 };
  if (prior && (prior.capitalLossCarryoverShortCents !== null || prior.capitalLossCarryoverLongCents !== null)) {
    carryover = { shortCents: prior.capitalLossCarryoverShortCents ?? 0, longCents: prior.capitalLossCarryoverLongCents ?? 0 };
  } else if (prior?.capitalLossCarryoverCents) {
    carryover = { shortCents: 0, longCents: prior.capitalLossCarryoverCents };
    note('Prior-year carryover total treated as long-term');
  } else if (priorProjection) {
    carryover = priorProjection.unusedCarryover;
    if (carryover.shortCents || carryover.longCents) note(`Capital loss carryover from the ${year - 1} projection (its assumptions apply)`);
  } else if (!prior) note(`No ${year - 1} federal return: no capital loss carryover counted`);
  const priorTax = prior ? prior.totalTaxCents : priorProjection?.federal.taxCents ?? null;
  const priorAgi = prior ? prior.agiCents : priorProjection?.federal.lines.find((l) => l.key === 'agi')?.cents ?? null;
  if (priorProjection) note(`Safe harbor uses the ${year - 1} projected tax until its return is filed`);

  // Federal
  const extra = change.extraWithholdingCents ?? 0;
  const paySource = projected.some((p) => p.grossCents) ? 'pay stubs and projected paychecks' : 'pay stubs';
  const projectedNote = (what: string) => {
    const n = projected.filter((p) => p.grossCents).length;
    return n ? `Includes ${what} ${plural(n, 'projected paycheck')} (estimated)` : undefined;
  };
  const extraNote = extra ? `Includes ${usd(extra)} extra withholding (what-if)` : undefined;
  const earlierNote = earlier.length ? `Includes ${usd(sum(earlier, (e) => e.grossCents))} earlier pay from stubs' year-to-date` : undefined;
  const federal = computeFederal({
    filingStatus, claimable, fullTimeStudent: profile.fullTimeStudent ?? false, wagesCents: gross, interestCents: sum(interest, (d) => d.cents),
    ordinaryDividendsCents: divTotal, qualifiedDividendsCents: 0, capitalGainDistributionsCents: sum(longDist, (d) => d.cents), sales, carryover, studentLoanInterestCents,
    k401PreTaxCents: k401, tuitionCents, scholarshipsCents, aotcYearsUsed: null,
    withheldCents: sum(pay, (p) => p.federalCents) + extra,
    priorYearTaxCents: priorTax, priorYearAgiCents: priorAgi,
    sources: { wagesCents: paySource, withheldCents: paySource, k401PreTaxCents: future ? 'scenario: 401(k)' : 'owner input: 401(k)',
      figures: `IRS figures for ${fed.year}`, ...(future && { ordinaryDividendsCents: `${incomeYear} dividends repeated` }),
      ...(priorProjection && { priorYearTaxCents: `${year - 1} projection` }) },
    assumptions: {
      wagesCents: [projectedNote('pay on'), earlierNote].filter(Boolean).join('; ') || undefined, ordinaryDividendsCents: divNote ?? undefined,
      withheldCents: [projectedNote('withholding on'), extraNote].filter(Boolean).join('; ') || undefined,
    },
  }, fed.figures);

  // States: pay sourced where earned, investment income where lived; the federal adjustments (401(k), student loan interest) come off wages
  const studentLoan = -(federal.lines.find((l) => l.key === 'studentLoanInterest')?.cents ?? 0);
  const adjustments = k401 + studentLoan;
  const share = gross ? Math.max(0, gross - adjustments) / gross : 1;
  const gains = [...sales.filter((s) => s.taxable).map((s) => ({ cents: s.proceedsCents - s.costCents + s.washDisallowedCents, date: s.date })), ...longDist]
    .map((g) => ({ wagesCents: 0, investmentCents: g.cents, sourceState: null, date: g.date }));
  // each check's share rounded on the running total, so the wages add up to the adjusted gross to the cent
  let paid = 0;
  const items: StateInput['incomeByPeriod'] = [
    ...pay.map((p) => ({ wagesCents: -Math.round(paid * share) + Math.round((paid += p.grossCents) * share), investmentCents: 0, sourceState: p.state, date: p.date })),
    ...cash.filter((d) => !longDist.includes(d)).map((d) => ({ wagesCents: 0, investmentCents: d.cents, sourceState: null, date: d.date })),
    ...gains,
  ];
  // the part of an adjustment the wages can't absorb (student loan interest above them) comes off the rest of the income at year end
  if (adjustments > gross) items.push({ wagesCents: 0, investmentCents: gross - adjustments, sourceState: null, date: end });
  // the federal loss limit and carryover spread over the gains and losses by size, on their own dates (at year end when there are none)
  let adjust = (federal.lines.find((l) => l.key === 'capitalGain')?.cents ?? 0) - sum(gains, (g) => g.investmentCents);
  let weight = sum(gains, (g) => Math.abs(g.investmentCents));
  if (adjust && !weight) items.push({ wagesCents: 0, investmentCents: adjust, sourceState: null, date: end });
  // a break-even sale has no weight: skipping it keeps 0/0 out of the totals
  for (const g of weight ? gains.filter((x) => x.investmentCents) : []) {
    const part = Math.round(adjust * Math.abs(g.investmentCents) / weight);
    weight -= Math.abs(g.investmentCents);
    adjust -= part;
    g.investmentCents += part;
  }
  const codes = [...new Set([...residency.map((p) => p.code), ...pay.map((p) => p.state).filter((c): c is string => !!c).sort()])];
  if (adjustments && codes.length) note('State follows the federal adjustments (401(k), student loan interest)');
  if (scholarshipsCents > tuitionCents && codes.length) note('Taxable scholarships not included in state income');
  const projectedIn = (code: string) => pay.some((p) => 'estimated' in p && p.state === code && p.grossCents);
  const state = (code: string, other: number) =>
    computeState({ ...stateInput(code, items, sum(pay.filter((p) => p.state === code), (p) => p.stateCents), other),
      withheldSource: projectedIn(code) ? 'pay stubs and projected paychecks' : 'pay stubs',
      withheldAssumption: projectedIn(code) ? 'Includes withholding on projected paychecks (estimated)' : undefined },
    modelOf(code)?.model ?? null);
  // credit for another state's tax: its tax on the income both states tax, as a share of what it taxes
  const first = new Map(codes.map((c) => [c, state(c, 0)]));
  const states = codes.map((code) => {
    const other = sum(codes.filter((c) => c !== code), (c) => {
      const doubled = sum(items.filter((i) => i.sourceState === c && residency.some((p) => p.code === code && p.from <= i.date && i.date <= p.to)),
        (i) => i.wagesCents + i.investmentCents);
      const taxed = first.get(c)!.lines.find((l) => l.key === 'stateIncome')?.cents ?? 0;
      return doubled > 0 && taxed > 0 ? Math.round(first.get(c)!.taxCents * doubled / taxed) : 0;
    });
    return other ? state(code, other) : first.get(code)!;
  });

  // a state with no figures has no tax to add: the total leaves it out and says so
  const returns = [federal, ...states];
  const missing = states.filter((r) => !r.supported).map((r) => r.jurisdiction);
  for (const c of missing) note(`${c} not supported: its tax isn't in the total`);
  const projection: TaxProjection = {
    year, openYears: openYears(today), asOf: today, complete: !missing.length,
    combinedBalanceCents: sum(returns.filter((r) => r.supported), (r) => r.balanceCents), returns, assumptions: notes,
    figures: { federalYear: fed.year, fallback: fed.fallback }, waysToSave: [], headsUp: [],
  };
  if ((opts.advice ?? true) && !Object.keys(change).length) {
    const delta = (ch: WhatIf) => {
      const a = assemble(deps, year, today, ch, { advice: false });
      return a.planned.blocked ? null : { savedCents: liability(projection.returns) - liability(a.projection.returns), sales: a.planned.sales };
    };
    Object.assign(projection, advise({
      db, year, projection, fed: fed.figures, safeHarborCents: federal.safeHarborCents, claimable, filingStatus, birthYear: profile.birthYear, inputs, scenario, move,
      lots: lots.lots, remainingPaychecks: projected.filter((x) => x.grossCents).length, stateModel: (code) => modelOf(code)?.model ?? null, delta,
      harvest: opts.harvest ?? true,
    }, today));
    for (const c of missing) note(`Withholding alerts skip ${c}: its tax isn't known`);
  }
  return { projection, unusedCarryover: federal.unusedCarryover, planned, federal };
}

export const project = (deps: Deps, year: number, today: string, change?: WhatIf, opts?: Options): TaxProjection =>
  assemble(deps, year, today, change, opts).projection;

/** The projection before and after a change; a blocked sale changes nothing. deltaCents is the change in the combined balance (+ better). */
export function whatIf(deps: Deps, year: number, today: string, change: WhatIf) {
  const before = assemble(deps, year, today, {}, { advice: false }).projection;
  const a = assemble(deps, year, today, change);
  if (a.planned.blocked) return { before, after: before, deltaCents: 0, blocked: a.planned.blocked, sales: [] as Sale[] };
  return { before, after: a.projection, deltaCents: a.projection.combinedBalanceCents - before.combinedBalanceCents, blocked: null, sales: a.planned.sales };
}
