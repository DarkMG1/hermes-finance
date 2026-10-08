-- hermes:foreign-keys-off
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('plaid', 'manual', 'actual', 'applecard')),
  source_id TEXT,
  date TEXT NOT NULL,
  authorized_date TEXT,
  amount_cents INTEGER NOT NULL,
  bank_description TEXT NOT NULL DEFAULT '',
  merchant_name TEXT,
  plaid_category TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  pending_source_id TEXT,
  removed_at TEXT,
  category_id TEXT REFERENCES categories(id),
  payee TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);
INSERT INTO transactions_new (id, account_id, source, source_id, date, authorized_date, amount_cents, bank_description, merchant_name,
  plaid_category, pending, pending_source_id, removed_at, category_id, payee, notes, created_at, updated_at)
SELECT id, account_id, source, source_id, date, authorized_date, amount_cents, bank_description, merchant_name,
  plaid_category, pending, pending_source_id, removed_at, category_id, payee, notes, created_at, updated_at FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX transactions_date ON transactions (date DESC, id DESC);
CREATE INDEX transactions_account_date ON transactions (account_id, date);
