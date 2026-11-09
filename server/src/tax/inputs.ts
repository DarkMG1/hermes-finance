import type { RothContribution, TaxInputs, TaxScenario } from '@hermes/shared';
import type { Db } from '../db.ts';

export function getTaxInputs(db: Db, year: number): TaxInputs {
  const row = db.prepare(`SELECT tuition_cents AS tuitionCents, scholarships_cents AS scholarshipsCents, student_loan_interest_cents AS studentLoanInterestCents,
    k401_cents AS k401Cents, updated_at AS updatedAt FROM tax_inputs WHERE year = ?`).get(year) as Omit<TaxInputs, 'year'> | undefined;
  return { year, tuitionCents: null, scholarshipsCents: null, studentLoanInterestCents: null, k401Cents: null, updatedAt: null, ...row };
}

export function getScenario(db: Db, year: number): TaxScenario {
  const row = db.prepare(`SELECT move_date AS moveDate, move_to AS moveTo, relocation_cents AS relocationCents, bonus_cents AS bonusCents, k401_cents AS k401Cents,
    roth_cents AS rothCents, updated_at AS updatedAt FROM tax_scenarios WHERE year = ?`).get(year) as Omit<TaxScenario, 'year'> | undefined;
  return { year, moveDate: null, moveTo: null, relocationCents: null, bonusCents: null, k401Cents: null, rothCents: null, updatedAt: null, ...row };
}

/** Plaid investment amounts are positive when cash leaves the account, so money coming into a Roth account is negative. A deposit or
 *  transfer-in not yet listed (and not dismissed) becomes a contribution for the year it was deposited; the owner can move it to the prior year. */
function suggestRoth(db: Db): void {
  db.prepare(`INSERT INTO roth_contributions (id, date, amount_cents, tax_year, transaction_id)
    SELECT 'roth-' || t.id, t.date, -t.amount_cents, CAST(substr(t.date, 1, 4) AS INTEGER), t.id
    FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.type = 'investment' AND a.subtype = 'roth' AND t.amount_cents < 0 AND ((t.type = 'cash' AND t.subtype = 'deposit') OR t.type = 'transfer')
      AND NOT EXISTS (SELECT 1 FROM roth_contributions r WHERE r.transaction_id = t.id)`).run();
}

export function listRothContributions(db: Db, taxYear: number): RothContribution[] {
  suggestRoth(db);
  return db.prepare(`SELECT id, date, amount_cents AS amountCents, tax_year AS taxYear, transaction_id AS transactionId FROM roth_contributions
    WHERE tax_year = ? AND dismissed = 0 ORDER BY date, id`).all(taxYear) as RothContribution[];
}
