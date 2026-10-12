-- Reconcile: the owner marks each money-out row once ("seen, meant to pay it"). A bank amount change after marking re-opens it.
ALTER TABLE transactions ADD COLUMN reconciled_at TEXT;
ALTER TABLE transactions ADD COLUMN reconciled_cents INTEGER;

-- One receipt photo per transaction, kept in the database so the encrypted backups cover it.
CREATE TABLE receipts (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  jpeg BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Backlog: the owner's first pass is September 2026, so everything earlier counts as reconciled.
-- Keep this WHERE in step with NEEDS_RECONCILE in server/src/reconcile.ts (reconcile.test.ts checks they agree).
UPDATE transactions AS t SET reconciled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reconciled_cents = amount_cents
 WHERE t.date < '2026-09-01'
   AND t.removed_at IS NULL AND t.pending = 0 AND t.amount_cents < 0 AND t.paid_by_person_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'investment')
   AND (CASE
     WHEN EXISTS (SELECT 1 FROM split_lines sl WHERE sl.transaction_id = t.id)
       THEN EXISTS (SELECT 1 FROM split_lines sl LEFT JOIN categories c ON c.id = sl.category_id
                     WHERE sl.transaction_id = t.id AND (c.id IS NULL OR (c.is_transfer = 0 AND c.is_income = 0)))
     WHEN t.person_id IS NOT NULL THEN 1
     WHEN t.category_id IS NOT NULL
       THEN EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category_id AND c.is_transfer = 0 AND c.is_income = 0)
     ELSE t.plaid_category IS NULL OR NOT (t.plaid_category GLOB 'INCOME*' OR t.plaid_category GLOB 'TRANSFER_IN*'
       OR t.plaid_category GLOB 'TRANSFER_OUT*' OR t.plaid_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
   END);
