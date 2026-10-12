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

-- Backlog: the owner's first pass is September 2026, so every earlier money-out row counts as reconciled, not just the
-- rows the rule selects today: a later edit (say, a new category) must not re-open a 2024 month on Home.
UPDATE transactions SET reconciled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reconciled_cents = amount_cents
 WHERE date < '2026-09-01' AND amount_cents < 0;
