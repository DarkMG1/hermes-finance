import type { TaxInputs, TaxScenario } from '@hermes/shared';
import { holdingKey } from '../backfill.ts';
import type { Db } from '../db.ts';
import { addDays } from '../days.ts';
import type { FederalFigures, StateModel } from './figures.ts';
import { listRothContributions } from './inputs.ts';
import type { Lot } from './lots.ts';
import type { Advice, TaxProjection, WhatIf } from './types.ts';

/** What `advise` needs from `assemble`: the projection without any what-if, the year's inputs and merged scenario (future years only),
 *  how many projected paychecks remain, and `delta`, the combined-balance improvement of a what-if (null when blocked; never computes advice). */
export type AdviceCtx = {
  db: Db; year: number; projection: TaxProjection; fed: FederalFigures; safeHarborCents: number; claimable: boolean;
  inputs: TaxInputs; scenario: TaxScenario | null; lots: Lot[]; remainingPaychecks: number;
  stateModel: (code: string) => StateModel | null; delta: (change: WhatIf) => number | null;
};

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ESTIMATED_THRESHOLD = 100_000, WITHHOLDING_THRESHOLD = 50_000, HEADS_UP_SAVING = 5_000;

export function advise(c: AdviceCtx, today: string): { waysToSave: Advice[]; headsUp: Advice[] } {
  const { db, year, projection: p, fed } = c;
  const thisYear = Number(today.slice(0, 4));
  const save: Advice[] = [], alerts: Advice[] = [];
  const item = (a: Omit<Advice, 'savingsCents' | 'dueDate'> & Partial<Pick<Advice, 'savingsCents' | 'dueDate'>>): Advice =>
    ({ savingsCents: null, dueDate: null, ...a });

  if (year === thisYear) {
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
      if (lots.reduce((s, l) => s + l.costCents, 0) <= Math.round(row.price * quantity)) continue;
      const saved = c.delta({ sell: [{ accountId, securityId, quantity }] });
      if (saved === null || saved <= 0) continue; // sheltered accounts and washed losses save nothing
      const ticker = key(lots[0]!);
      harvest.push(item({
        kind: 'harvest_loss', title: `Sell ${ticker} to harvest a loss`, savingsCents: saved,
        detail: `Selling all of ${ticker} now realizes a loss that lowers this year's tax. Wash-sale rule: don't buy it or a substantially identical fund back within 30 days, including in the Roth IRA.`,
        askPrompt: `Should I sell my ${ticker} to harvest the loss?`,
      }));
    }
    save.push(...harvest.sort((a, b) => b.savingsCents! - a.savingsCents!).slice(0, 3));
  }

  if (openYearIsRoth(year, today)) {
    const due = `${year + 1}-04-15`;
    const put = listRothContributions(db, year).reduce((s, r) => s + r.amountCents, 0);
    const room = fed.ira.limit - put;
    if (room > 0) save.push(item({
      kind: 'roth_room', title: `Roth IRA room left for ${year}`, dueDate: due,
      detail: `You can still put ${usd(room)} into a Roth IRA for ${year} until ${due}. It doesn't lower this year's tax; it grows tax-free.`,
      askPrompt: `Should I put more into my Roth IRA for ${year}?`,
    }));
    if (room < 0) alerts.push(item({
      kind: 'over_limit', title: `Roth IRA contributions over the ${year} limit`, dueDate: due,
      detail: `You put in ${usd(-room)} more than the ${usd(fed.ira.limit)} limit. Take the extra out before ${due} to avoid a 6% yearly penalty.`,
      askPrompt: `How do I fix my Roth IRA over-contribution for ${year}?`,
    }));
  }

  const k401 = c.scenario ? c.scenario.k401Cents : c.inputs.k401Cents;
  if (c.scenario && (k401 ?? 0) < fed.k401Limit) {
    const saved = c.delta({ scenario: { k401Cents: fed.k401Limit } });
    if (saved !== null && saved > 0) save.push(item({
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

  const dest = c.scenario?.moveDate && c.scenario.moveTo ? c.stateModel(c.scenario.moveTo) : null;
  if (dest && 'movingExpenses' in dest && dest.movingExpenses) {
    save.push(item({
      kind: 'moving_expenses', title: 'Moving costs may be deductible',
      detail: "Your new state lets you deduct moving costs the employer didn't pay; keep receipts.",
      askPrompt: 'Can I deduct my moving costs on my state return?',
    }));
  }

  const fedReturn = p.returns[0]!;
  // the underpayment-penalty test: a lot owed AND withholding short of the safe harbor; a refund never triggers it
  const owedBig = p.returns.some((r) => r.balanceCents <= -ESTIMATED_THRESHOLD) && fedReturn.withheldCents < c.safeHarborCents;
  const due = [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`].find((d) => d >= today && d <= addDays(today, 30));
  if (owedBig && due) alerts.push(item({
    kind: 'estimated_payment', title: 'Estimated tax payment due soon', dueDate: due,
    detail: `A quarterly estimated payment is due ${due}. Withholding so far may not cover ${year}'s tax; paying by then avoids a penalty.`,
    askPrompt: 'How much estimated tax should I pay this quarter?',
  }));

  if (p.combinedBalanceCents < -WITHHOLDING_THRESHOLD) {
    const short = -p.combinedBalanceCents;
    const per = c.remainingPaychecks ? Math.ceil(short / c.remainingPaychecks / 100) : null;
    alerts.push(item({
      kind: 'withholding_short', title: `Withholding is short by ${usd(short)}`,
      detail: `You're projected to owe ${usd(short)} for ${year}.${per === null ? '' : ` Withholding about $${per} more from each of the ${c.remainingPaychecks} remaining paychecks would cover it.`}`,
      askPrompt: `How should I change my withholding for ${year}?`,
    }));
  }

  const headsUp = [...alerts, ...save.filter((a) => (a.savingsCents ?? 0) >= HEADS_UP_SAVING)];
  return { waysToSave: save, headsUp };
}

/** The Roth limit is open for a tax year until Apr 15 of the next. */
const openYearIsRoth = (year: number, today: string) => today <= `${year + 1}-04-15`;
