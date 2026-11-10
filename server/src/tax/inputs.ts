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
 *  transfer-in (not a transfer out of another Roth account within a week, which only moves money between Roths) is a contribution source. */
const SOURCES = `SELECT t.id, t.date, -t.amount_cents AS cents FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
  WHERE a.type = 'investment' AND a.subtype = 'roth' AND t.amount_cents < 0 AND ((t.type = 'cash' AND t.subtype = 'deposit') OR t.type = 'transfer')
    AND NOT (t.type = 'transfer' AND EXISTS (SELECT 1 FROM investment_transactions o JOIN accounts b ON b.id = o.account_id
      WHERE b.subtype = 'roth' AND o.account_id <> t.account_id AND o.type = 'transfer' AND o.amount_cents = -t.amount_cents
        AND abs(julianday(o.date) - julianday(t.date)) <= 7))`;

/** Suggestions follow their source on every read: a new one becomes a contribution for the year it was deposited, a changed one takes the new
 *  date and amount unless the owner edited either (the owner's tax year stays while the new date allows it), and one whose source is gone (or no longer qualifies) stops counting. */
function suggestRoth(db: Db): void {
  db.prepare(`INSERT INTO roth_contributions (id, date, amount_cents, tax_year, transaction_id)
    SELECT 'roth-' || s.id, s.date, s.cents, CAST(substr(s.date, 1, 4) AS INTEGER), s.id FROM (${SOURCES}) s
    WHERE NOT EXISTS (SELECT 1 FROM roth_contributions r WHERE r.transaction_id = s.id)`).run();
  db.prepare(`UPDATE roth_contributions AS r SET date = s.date, amount_cents = s.cents,
      tax_year = CASE WHEN r.tax_year = CAST(substr(s.date, 1, 4) AS INTEGER) - 1 AND substr(s.date, 6) <= '04-15' THEN r.tax_year ELSE CAST(substr(s.date, 1, 4) AS INTEGER) END
    FROM (${SOURCES}) s WHERE r.transaction_id = s.id AND r.owner_edited = 0 AND (r.date <> s.date OR r.amount_cents <> s.cents)`).run();
}

export function listRothContributions(db: Db, taxYear: number): RothContribution[] {
  suggestRoth(db);
  return db.prepare(`SELECT id, date, amount_cents AS amountCents, tax_year AS taxYear, transaction_id AS transactionId FROM roth_contributions
    WHERE tax_year = ? AND dismissed = 0 AND (transaction_id IS NULL OR transaction_id IN (SELECT id FROM (${SOURCES})))
    ORDER BY date, id`).all(taxYear) as RothContribution[];
}
