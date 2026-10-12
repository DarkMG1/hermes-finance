// Money out the owner should look at once a month. Over alias `t` (transactions). Migration 016's backlog step repeats this
// WHERE; reconcile.test.ts checks the two agree.
export const NEEDS_RECONCILE = `(
  t.removed_at IS NULL AND t.pending = 0 AND t.amount_cents < 0 AND t.paid_by_person_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'investment')
  AND (CASE
    WHEN EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
      THEN EXISTS (SELECT 1 FROM split_lines sl LEFT JOIN categories c ON c.id = sl.category_id
                    WHERE sl.transaction_id = t.id AND (c.id IS NULL OR (c.is_transfer = 0 AND c.is_income = 0)))
    -- paying a person (a roommate) is money that left: it counts whatever Plaid called it
    WHEN t.person_id IS NOT NULL THEN 1
    WHEN t.category_id IS NOT NULL
      THEN EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category_id AND c.is_transfer = 0 AND c.is_income = 0)
    ELSE t.plaid_category IS NULL OR NOT (t.plaid_category GLOB 'INCOME*' OR t.plaid_category GLOB 'TRANSFER_IN*'
      OR t.plaid_category GLOB 'TRANSFER_OUT*' OR t.plaid_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
  END))`;

// marked, and the bank hasn't changed the amount since
export const OPEN = '(t.reconciled_at IS NULL OR t.reconciled_cents != t.amount_cents)';
