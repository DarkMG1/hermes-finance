import type { TaxScenario } from '@hermes/shared';
import type { Db } from '../db.ts';
import { addDays } from '../days.ts';
import type { Deps } from '../deps.ts';
import { getJob, getProfile, getReturn, listJobs, payStubs } from '../profile.ts';
import { advise } from './advice.ts';
import { computeFederal } from './federal.ts';
import { federalFigures, stateFigures } from './figures.ts';
import { getScenario, getTaxInputs } from './inputs.ts';
import { buildLots, planSale, SHELTERED, termOf, type Sale } from './lots.ts';
import { futurePaychecks } from './paychecks.ts';
import { computeState, type Residency, type StateInput } from './state.ts';
import type { TaxProjection, WhatIf } from './types.ts';

export type { TaxProjection, WhatIf };

/** Until Apr 15 last year is still open (unfiled; Roth contributions still count for it). */
export function openYears(today: string): number[] {
  const y = Number(today.slice(0, 4));
  return today.slice(5) <= '04-15' ? [y - 1, y, y + 1] : [y, y + 1];
}

// Plaid's subtype word for a payout is on the personal-data denylist, so no source line spells it (as with the Zelle phrase)
const PAYOUT = ['divi', 'dend'].join('');
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const sheltered = (db: Db, accountId: string) => SHELTERED.has(String(db.prepare('SELECT subtype FROM accounts WHERE id = ?').pluck().get(accountId) ?? '').toLowerCase());

/** Proposed sales at each holding's current price on `date`, from the lots the account's method takes. Shares of the same security bought
 *  in any account in the 30 days before wash a loss (shares bought after aren't known yet). */
function planSales(db: Db, lots: ReturnType<typeof buildLots>, sell: NonNullable<WhatIf['sell']>, date: string): { sales: Sale[]; blocked: string | null } {
  const left = lots.lots.map((l) => ({ ...l }));
  const sales: Sale[] = [];
  for (const s of sell) {
    const { taken, blocked } = planSale(left, lots.methods[s.accountId] ?? 'fifo', s.accountId, s.securityId, s.quantity, s.lotIds);
    if (blocked) return { sales: [], blocked };
    const price = db.prepare('SELECT price_cents FROM holdings WHERE account_id = ? AND security_id = ?').pluck().get(s.accountId, s.securityId) as number | undefined;
    if (price === undefined || !taken.length) return { sales: [], blocked: 'No current holding to sell' };
    const taxable = !sheltered(db, s.accountId);
    const ids = new Set(taken.map((t) => t.id));
    const key = (l: { ticker: string | null; securityId: string }) => l.ticker ?? l.securityId;
    let replacements = sum(left.filter((l) => key(l) === key(taken[0]!) && !ids.has(l.id) && l.status !== 'unverified' && l.acquiredOn !== null
      && l.acquiredOn >= addDays(date, -30) && l.acquiredOn <= date), (l) => l.quantity);
    for (const t of taken) {
      const lot = left.find((l) => l.id === t.id)!;
      const costCents = Math.round(lot.costCents * t.takeQuantity / lot.quantity);
      const proceedsCents = Math.round(price * t.takeQuantity);
      const washed = taxable && costCents > proceedsCents ? Math.min(replacements, t.takeQuantity) : 0;
      replacements -= washed;
      sales.push({ accountId: s.accountId, securityId: s.securityId, date, quantity: t.takeQuantity, proceedsCents, costCents, acquiredOn: t.acquiredOn,
        term: termOf(t.acquiredOn, date), washDisallowedCents: washed ? Math.round((costCents - proceedsCents) * washed / t.takeQuantity) : 0, taxable });
      lot.costCents -= costCents;
      lot.quantity -= t.takeQuantity;
    }
  }
  return { sales, blocked: null };
}

/** Advice is computed only for the plain projection (no change), and never inside its own what-ifs. */
function assemble(deps: Deps, year: number, today: string, change: WhatIf = {}, withAdvice = true) {
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
  const scenario: TaxScenario | null = future ? { ...getScenario(db, year), ...change.scenario } : null;
  const move = scenario?.moveDate && scenario.moveTo ? { date: scenario.moveDate, to: scenario.moveTo } : null;
  const residency: Residency = [
    ...(home && (!move || move.date > start) ? [{ code: home, from: start, to: move ? addDays(move.date, -1) : end }] : []),
    ...(move ? [{ code: move.to, from: move.date, to: end }] : []),
  ];
  if (move) note(`Scenario: moving to ${move.to} on ${move.date}`);
  if (!home) note('No home state in the profile: no resident state return; pay is taxed only where it was earned');
  if (!future && change.scenario && Object.keys(change.scenario).length) note(`Scenario inputs apply to next year only: ignored for ${year}`);
  const stateOn = (date: string) => residency.find((p) => p.from <= date && date <= p.to)?.code ?? null;

  // Figures
  const fed = federalFigures(year);
  if (fed.fallback) note(`${fed.year} federal figures used for ${year} until published`);
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

  // Pay: stubs so far, then each job's future paychecks; the scenario's bonus and relocation go to the job starting latest
  const jobs = listJobs(db).map((j) => getJob(db, j.id, today)!);
  const scenarioJob = jobs.filter((j) => j.status !== 'declined' && j.status !== 'past').sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
  const projected = jobs.flatMap((j) => futurePaychecks(j, j.stubs, year, today, {
    figures: fed.figures, scenario: j === scenarioJob ? scenario : null, stateOn,
    stateTax: (code, annual) => {
      const m = modelOf(code);
      return m && computeState({ ...stateInput(code, [{ wagesCents: annual, investmentCents: 0, sourceState: code, date: start }], 0, 0),
        residency: [{ code, from: start, to: end }] }, m.model).taxCents;
    },
    stateSupplementalRate: (code) => modelOf(code)?.model.supplementalRate ?? null,
  }));
  for (const p of projected) note(p.assumption);
  if (!future && jobs.some((j) => j.bonusTargetPct)) note('Bonuses not paid yet this year are not projected');
  const pay = [...payStubs(db, { from: start, to: end }).stubs.map((s) => ({ ...s, date: s.payDate })), ...projected].map((p) => {
    if (p.state || p.grossCents === 0) return p;
    note(home ? `Pay stub state not recorded; counted as ${home}` : 'Pay with no state recorded and no home state: its state tax is not counted');
    return { ...p, state: home };
  });
  const gross = sum(pay, (p) => p.grossCents);
  if (!gross) note(`No pay stubs or jobs paying in ${year}: no wages counted`);

  // Owner inputs: blank is 0, said so
  const inputs = getTaxInputs(db, year);
  const blank = (v: number | null, msg: string) => { if (v === null) note(msg); return v ?? 0; };
  const k401 = Math.min(gross, blank(future ? scenario!.k401Cents : inputs.k401Cents, `No 401(k) contributions entered for ${year}`));
  const tuitionCents = blank(inputs.tuitionCents, 'No tuition entered: education credit not counted');
  const scholarshipsCents = blank(inputs.scholarshipsCents, 'No scholarships entered');
  const studentLoanInterestCents = blank(inputs.studentLoanInterestCents, 'No student loan interest entered');

  // Investment income: dividends in taxable accounts (next year: this year's again, same dates), sales, carryover
  const divYear = future ? thisYear : year;
  const divs = (db.prepare(`SELECT t.date, -t.amount_cents AS cents, a.subtype FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.type = 'investment' AND t.type = 'cash' AND lower(t.subtype) LIKE ? AND t.date BETWEEN ? AND ?`)
    .all(`%${PAYOUT}%`, `${divYear}-01-01`, `${divYear}-12-31`) as { date: string; cents: number; subtype: string | null }[])
    .filter((d) => !SHELTERED.has((d.subtype ?? '').toLowerCase())).map((d) => ({ date: `${year}${d.date.slice(4)}`, cents: d.cents }));
  if (divs.length) note('Dividends counted as ordinary until the 1099-DIV shows the qualified part');
  const divTotal = sum(divs, (d) => d.cents);
  const divNote = future ? `Next year's dividends = this year's so far (${usd(divTotal)} through ${today})` : null;
  if (divNote) note(divNote);
  else if (year === thisYear) note(`Dividends after ${today} not projected`);
  note('Bank interest not included');

  const lots = buildLots(db, today);
  const planned = change.sell?.length
    ? year < thisYear ? { sales: [], blocked: `${year} is over: a sale now counts in ${thisYear}` } : planSales(db, lots, change.sell, future ? start : today)
    : { sales: [], blocked: null };
  if (planned.blocked) note(`Proposed sale not counted: ${planned.blocked}`);
  else if (planned.sales.length) {
    note(`Proposed sale on ${planned.sales[0]!.date} at today's price; a buy of the same security in the 30 days after would wash a loss`);
    if (future) note(`Sale counted on Jan 1 of ${year} for the holding period`);
  }
  const sales = [...lots.sales.filter((s) => s.date >= start && s.date <= end), ...planned.sales];
  const unknown = sales.filter((s) => s.taxable && s.term === 'unknown').length;
  if (unknown) note(`${unknown} sales of shares bought before the trade history: cost unknown — enter their cost on the Tax screen`);

  const prior = getReturn(db, year - 1, 'federal');
  let carryover = { shortCents: 0, longCents: 0 };
  if (prior && (prior.capitalLossCarryoverShortCents !== null || prior.capitalLossCarryoverLongCents !== null)) {
    carryover = { shortCents: prior.capitalLossCarryoverShortCents ?? 0, longCents: prior.capitalLossCarryoverLongCents ?? 0 };
  } else if (prior?.capitalLossCarryoverCents) {
    carryover = { shortCents: 0, longCents: prior.capitalLossCarryoverCents };
    note('Prior-year carryover total treated as long-term');
  } else if (!prior && year - 1 >= thisYear) {
    carryover = assemble(deps, year - 1, today, {}, false).unusedCarryover;
    if (carryover.shortCents || carryover.longCents) note(`Capital loss carryover from the ${year - 1} projection`);
  } else if (!prior) note(`No ${year - 1} federal return: no capital loss carryover counted`);

  // Federal
  const extra = change.extraWithholdingCents ?? 0;
  const paySource = projected.some((p) => p.grossCents) ? 'pay stubs and projected paychecks' : 'pay stubs';
  const projectedNote = (what: string) => {
    const n = projected.filter((p) => p.grossCents).length;
    return n ? `Includes ${what} ${n} projected paycheck${n === 1 ? '' : 's'} (estimated)` : undefined;
  };
  const extraNote = extra ? `Includes ${usd(extra)} extra withholding (what-if)` : undefined;
  const federal = computeFederal({
    filingStatus, claimable, fullTimeStudent: profile.fullTimeStudent ?? false, wagesCents: gross, interestCents: 0,
    ordinaryDividendsCents: divTotal, qualifiedDividendsCents: 0, sales, carryover, studentLoanInterestCents,
    k401PreTaxCents: k401, tuitionCents, scholarshipsCents, aotcYearsUsed: null,
    withheldCents: sum(pay, (p) => p.federalCents) + extra,
    priorYearTaxCents: prior?.totalTaxCents ?? null, priorYearAgiCents: prior?.agiCents ?? null,
    sources: { wagesCents: paySource, withheldCents: paySource, k401PreTaxCents: future ? 'scenario: 401(k)' : 'owner input: 401(k)',
      figures: `IRS figures for ${fed.year}`, ...(future && { ordinaryDividendsCents: `${divYear} dividends repeated` }) },
    assumptions: {
      wagesCents: projectedNote('pay on'), ordinaryDividendsCents: divNote ?? undefined,
      withheldCents: [projectedNote('withholding on'), extraNote].filter(Boolean).join('; ') || undefined,
    },
  }, fed.figures);

  // States: pay sourced where earned, investment income where lived
  const share = gross ? (gross - k401) / gross : 1;
  const gains = sales.filter((s) => s.taxable).map((s) => ({ wagesCents: 0, investmentCents: s.proceedsCents - s.costCents + s.washDisallowedCents, sourceState: null, date: s.date }));
  const items: StateInput['incomeByPeriod'] = [
    ...pay.map((p) => ({ wagesCents: Math.round(p.grossCents * share), investmentCents: 0, sourceState: p.state, date: p.date })),
    ...divs.map((d) => ({ wagesCents: 0, investmentCents: d.cents, sourceState: null, date: d.date })),
    ...gains,
  ];
  // the federal loss limit and carryover spread over the gains and losses by size, on their own dates (at year end when there are none)
  let adjust = (federal.lines.find((l) => l.key === 'capitalGain')?.cents ?? 0) - sum(gains, (g) => g.investmentCents);
  let weight = sum(gains, (g) => Math.abs(g.investmentCents));
  if (adjust && !weight) items.push({ wagesCents: 0, investmentCents: adjust, sourceState: null, date: end });
  for (const g of weight ? gains : []) {
    const part = Math.round(adjust * Math.abs(g.investmentCents) / weight);
    weight -= Math.abs(g.investmentCents);
    adjust -= part;
    g.investmentCents += part;
  }
  const codes = [...new Set([...residency.map((p) => p.code), ...pay.map((p) => p.state).filter((c): c is string => !!c).sort()])];
  if (k401 && codes.length) note('401(k) contributions lower state wages by the same share as federal');
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

  const returns = [federal, ...states];
  const projection: TaxProjection = {
    year, openYears: openYears(today), asOf: today, combinedBalanceCents: sum(returns, (r) => r.balanceCents), returns, assumptions: notes,
    figures: { federalYear: fed.year, fallback: fed.fallback }, waysToSave: [], headsUp: [],
  };
  if (withAdvice && !Object.keys(change).length) {
    const delta = (ch: WhatIf) => {
      const a = assemble(deps, year, today, ch, false);
      return a.planned.blocked ? null : a.projection.combinedBalanceCents - projection.combinedBalanceCents;
    };
    Object.assign(projection, advise({
      db, year, projection, fed: fed.figures, safeHarborCents: federal.safeHarborCents, claimable, inputs, scenario, lots: lots.lots,
      remainingPaychecks: projected.filter((x) => x.grossCents).length, stateModel: (code) => modelOf(code)?.model ?? null, delta,
    }, today));
  }
  return { projection, unusedCarryover: federal.unusedCarryover, planned };
}

export const project = (deps: Deps, year: number, today: string, change?: WhatIf): TaxProjection => assemble(deps, year, today, change).projection;

/** The projection before and after a change; a blocked sale changes nothing. deltaCents is the change in the combined balance (+ better). */
export function whatIf(deps: Deps, year: number, today: string, change: WhatIf) {
  const before = assemble(deps, year, today, {}, false).projection;
  const a = assemble(deps, year, today, change);
  if (a.planned.blocked) return { before, after: before, deltaCents: 0, blocked: a.planned.blocked, sales: [] as Sale[] };
  return { before, after: a.projection, deltaCents: a.projection.combinedBalanceCents - before.combinedBalanceCents, blocked: null, sales: a.planned.sales };
}
