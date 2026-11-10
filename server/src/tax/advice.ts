import type { TaxInputs, TaxScenario } from '@hermes/shared';
import { holdingKey } from '../backfill.ts';
import type { Db } from '../db.ts';
import { addDays } from '../days.ts';
import type { FederalInput } from './federal.ts';
import type { FederalFigures, StateModel } from './figures.ts';
import { listRothContributions } from './inputs.ts';
import type { Lot, Sale } from './lots.ts';
import type { Advice, TaxProjection, WhatIf } from './types.ts';

/** What `advise` needs from `assemble`: the projection without any what-if, the year's inputs and merged scenario (future years only), the
 *  year's move, how many projected paychecks remain, and `delta`, what a what-if saves in tax (the drop in the returns' liability, so a
 *  withholding change never counts) with its sales (null when blocked; never computes advice). `harvest: false` skips the sale what-ifs. */
export type AdviceCtx = {
  db: Db; year: number; projection: TaxProjection; fed: FederalFigures; safeHarborCents: number; claimable: boolean;
  filingStatus: FederalInput['filingStatus']; birthYear: number | null;
  inputs: TaxInputs; scenario: TaxScenario | null; move: { date: string; to: string } | null; lots: Lot[]; remainingPaychecks: number;
  stateModel: (code: string) => StateModel | null; delta: (change: WhatIf) => { savedCents: number; sales: Sale[] } | null; harvest: boolean;
};

export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const loss = (sales: Sale[], term: Sale['term']) =>
  -sales.filter((s) => s.taxable && s.term === term).reduce((a, s) => a + s.proceedsCents - s.costCents + s.washDisallowedCents, 0);
const ESTIMATED_THRESHOLD = 100_000, WITHHOLDING_THRESHOLD = 50_000, HEADS_UP_SAVING = 5_000;

export function advise(c: AdviceCtx, today: string): { waysToSave: Advice[]; headsUp: Advice[] } {
  const { db, year, projection: p, fed } = c;
  const thisYear = Number(today.slice(0, 4));
  const save: Advice[] = [], alerts: Advice[] = [];
  const item = (a: Omit<Advice, 'savingsCents' | 'dueDate'> & Partial<Pick<Advice, 'savingsCents' | 'dueDate'>>): Advice =>
    ({ savingsCents: null, dueDate: null, ...a });

  if (year === thisYear && c.harvest) {
    const key = (l: Lot) => holdingKey({ securityId: l.securityId, ticker: l.ticker, type: null, isCash: 0 });
    // from the stored buys, not the lots: a lot bought and already sold is gone from the lots but still washes a loss
    const bought = new Set((db.prepare(`SELECT s.id AS securityId, s.ticker FROM investment_transactions t JOIN securities s ON s.id = t.security_id
      WHERE t.type = 'buy' AND t.quantity > 0 AND t.date BETWEEN ? AND ?`).all(addDays(today, -30), today) as { securityId: string; ticker: string | null }[])
      .map((r) => holdingKey({ ...r, type: null, isCash: 0 })));
    const positions = new Map<string, Lot[]>();
    for (const l of c.lots) positions.set(`${l.accountId}\0${l.securityId}`, [...(positions.get(`${l.accountId}\0${l.securityId}`) ?? []), l]);
    const harvest: Advice[] = [];
    for (const lots of positions.values()) {
      const { accountId, securityId } = lots[0]!;
      const row = db.prepare(`SELECT h.price_cents AS price, a.subtype FROM holdings h JOIN accounts a ON a.id = h.account_id
        WHERE h.account_id = ? AND h.security_id = ?`).get(accountId, securityId) as { price: number; subtype: string | null } | undefined;
      const quantity = lots.reduce((s, l) => s + l.quantity, 0);
      if (!row || lots.some((l) => l.status === 'unverified') || bought.has(key(lots[0]!))) continue;
      // held in another account too (a Roth reinvesting its payouts, say): a buy there after the sale could wash the loss
      if (c.lots.some((l) => l.accountId !== accountId && key(l) === key(lots[0]!))) continue;
      if (lots.reduce((s, l) => s + l.costCents, 0) <= Math.round(row.price * quantity)) continue;
      const d = c.delta({ sell: [{ accountId, securityId, quantity }] });
      if (d === null || d.savedCents <= 0) continue; // sheltered accounts and washed losses save nothing
      const ticker = key(lots[0]!);
      const account = db.prepare('SELECT name FROM accounts WHERE id = ?').pluck().get(accountId) as string;
      const split = [['short', 'short-term'], ['long', 'long-term']].map(([t, label]) => [loss(d.sales, t as Sale['term']), label] as const)
        .filter(([cents]) => cents > 0).map(([cents, label]) => `${usd(cents)} ${label}`).join(' and ');
      harvest.push(item({
        kind: 'harvest_loss', title: `Sell ${ticker} in ${account} to harvest a loss`, savingsCents: d.savedCents,
        detail: `Selling all of ${ticker} in ${account} now realizes a loss${split ? ` (${split})` : ''} that lowers this year's tax. Wash-sale rule: don't buy it or a substantially identical fund back within 30 days, including in the Roth IRA.`,
        askPrompt: `Should I sell my ${ticker} in ${account} to harvest the loss?`,
      }));
    }
    save.push(...harvest.sort((a, b) => b.savingsCents! - a.savingsCents!).slice(0, 3));
  }

  if (openYearIsRoth(year, today)) {
    // the limit (plus the catch-up from 50), capped at taxable pay, cut by the income phase-out
    const due = `${year + 1}-04-15`;
    const line = (key: string) => p.returns[0]!.lines.find((l) => l.key === key)?.cents ?? 0;
    const pay = Math.max(0, line('wages') + line('scholarshipIncome'));
    const range: [number, number] = c.filingStatus === 'married_joint' ? fed.rothPhaseOut.marriedJoint
      : c.filingStatus === 'married_separate' ? [0, 1_000_000] : fed.rothPhaseOut.single;
    const kept = Math.min(1, Math.max(0, (range[1] - line('agi')) / (range[1] - range[0])));
    const limit = fed.ira.limit + (c.birthYear !== null && year - c.birthYear >= 50 ? fed.ira.catchUp50 : 0);
    const max = Math.round(Math.min(limit, pay) * kept);
    const planned = c.scenario?.rothCents ?? 0;
    const put = listRothContributions(db, year).reduce((s, r) => s + r.amountCents, 0) + planned;
    const room = max - put;
    const why = [
      pay < limit && `Your ${year} limit is your taxable pay (${usd(pay)}).`,
      kept < 1 && `Your projected income phases the limit down to ${usd(max)}.`,
      planned > 0 && `Counts the ${usd(planned)} planned in the scenario.`,
    ].filter(Boolean).join(' ');
    if (room > 0) save.push(item({
      kind: 'roth_room', title: `Roth IRA room left for ${year}`, dueDate: due,
      detail: `You can still put ${usd(room)} into a Roth IRA for ${year} until ${due}.${why ? ` ${why}` : ''} It doesn't lower this year's tax; it grows tax-free.`,
      askPrompt: `Should I put more into my Roth IRA for ${year}?`,
    }));
    if (room < 0) alerts.push(item({
      kind: 'over_limit', title: `Roth IRA contributions over the ${year} limit`, dueDate: due,
      detail: `You put in ${usd(-room)} more than your ${usd(max)} limit.${why ? ` ${why}` : ''} Take the extra out before ${due} to avoid a 6% yearly penalty.`,
      askPrompt: `How do I fix my Roth IRA over-contribution for ${year}?`,
    }));
  }

  const k401 = c.scenario ? c.scenario.k401Cents : c.inputs.k401Cents;
  if (c.scenario && (k401 ?? 0) < fed.k401Limit) {
    const saved = c.delta({ scenario: { k401Cents: fed.k401Limit } })?.savedCents ?? 0;
    if (saved > 0) save.push(item({
      kind: 'k401_room', title: `More 401(k) room in ${year}`, savingsCents: saved,
      detail: `Raising 401(k) contributions to the ${usd(fed.k401Limit)} limit would lower ${year} taxes, as far as your pay allows.`,
      askPrompt: `Should I raise my 401(k) contributions in ${year}?`,
    }));
  }
  if ((k401 ?? 0) > fed.k401Limit) alerts.push(item({
    kind: 'over_limit', title: `401(k) over the ${year} limit`,
    detail: `${usd(k401!)} is more than the ${usd(fed.k401Limit)} limit. The extra must come back out.`,
    askPrompt: `What happens if I put too much into my 401(k) in ${year}?`,
  }));

  if (c.inputs.tuitionCents === null) save.push(item({
    kind: 'education_credit', title: 'Enter tuition and scholarships',
    detail: `Tuition for ${year} isn't entered, so no education credit is counted. Enter tuition and scholarships on the Tax screen.`,
    askPrompt: `Do I qualify for an education credit in ${year}?`,
  }));
  else if (c.claimable) save.push(item({
    kind: 'education_credit', title: 'Education credit not available',
    detail: 'The education credit isn\'t available while someone else can claim you as a dependent.',
    askPrompt: `Why can't I claim the education credit in ${year}?`,
  }));

  if (c.inputs.studentLoanInterestCents === null && db.prepare(`SELECT 1 FROM transactions t JOIN categories k ON k.id = t.category_id
    WHERE t.removed_at IS NULL AND t.amount_cents < 0 AND t.date BETWEEN ? AND ? AND k.name LIKE '%loan%' LIMIT 1`).get(`${year}-01-01`, `${year}-12-31`)) {
    save.push(item({
      kind: 'student_loan_interest', title: 'Enter student loan interest',
      detail: `You paid on a loan in ${year}, but no student loan interest is entered. Your loan servicer's statement shows the interest; it can lower your tax.`,
      askPrompt: `Can I deduct student loan interest in ${year}?`,
    }));
  }

  const dest = c.move ? c.stateModel(c.move.to) : null;
  if (dest && 'movingExpenses' in dest && dest.movingExpenses) {
    save.push(item({
      kind: 'moving_expenses', title: 'Moving costs may be deductible',
      detail: "Your new state lets you deduct moving costs the employer didn't pay; keep receipts.",
      askPrompt: 'Can I deduct my moving costs on my state return?',
    }));
  }

  // each supported return on its own (a state with no figures has no known tax): a refund on one never hides what's owed on another
  const returns = p.returns.filter((r) => r.supported);
  const name = (r: { jurisdiction: string }) => (r.jurisdiction === 'federal' ? 'federal' : r.jurisdiction);
  // the underpayment-penalty test: a lot owed AND withholding short of the safe harbor (a state's: 90% of its tax); a refund never triggers it
  const due = [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`].find((d) => d >= today && d <= addDays(today, 30));
  for (const r of due ? returns : []) {
    const harbor = r.jurisdiction === 'federal' ? c.safeHarborCents : Math.round(0.9 * r.taxCents);
    if (r.balanceCents > -ESTIMATED_THRESHOLD || r.withheldCents >= harbor) continue;
    alerts.push(item({
      kind: 'estimated_payment', title: `Estimated ${name(r)} tax payment due soon`, dueDate: due!,
      detail: `A quarterly estimated ${name(r)} payment is due ${due}. Withholding so far may not cover ${year}'s ${name(r)} tax; paying by then avoids a penalty.`,
      askPrompt: `How much estimated ${name(r)} tax should I pay this quarter?`,
    }));
  }

  // only while paychecks can still change it
  for (const r of year >= thisYear ? returns : []) {
    if (r.balanceCents >= -WITHHOLDING_THRESHOLD) continue;
    const short = -r.balanceCents;
    const form = r.jurisdiction === 'federal' ? 'W-4' : `${r.jurisdiction} withholding certificate`;
    const per = c.remainingPaychecks ? Math.ceil(short / c.remainingPaychecks / 100) : null;
    alerts.push(item({
      kind: 'withholding_short', title: `${r.jurisdiction === 'federal' ? 'Federal' : r.jurisdiction} withholding is short by ${usd(short)}`,
      detail: `You're projected to owe ${usd(short)} on the ${year} ${name(r)} return.${per === null ? '' : ` Withholding about $${per} more from each of the ${c.remainingPaychecks} remaining paychecks would cover it.`} Change it on your ${form}.`,
      askPrompt: `How should I change my ${name(r)} withholding for ${year}?`,
    }));
  }

  const headsUp = [...alerts, ...save.filter((a) => (a.savingsCents ?? 0) >= HEADS_UP_SAVING)];
  return { waysToSave: save, headsUp };
}

/** The Roth limit is open for a tax year until Apr 15 of the next. */
const openYearIsRoth = (year: number, today: string) => today <= `${year + 1}-04-15`;
