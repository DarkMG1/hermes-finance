-- owner-entered figures a tax projection needs, per year
CREATE TABLE tax_inputs (
  year INTEGER PRIMARY KEY,
  tuition_cents INTEGER,
  scholarships_cents INTEGER,
  student_loan_interest_cents INTEGER,
  k401_cents INTEGER,
  updated_at TEXT NOT NULL
);
-- next year's what-ifs
CREATE TABLE tax_scenarios (
  year INTEGER PRIMARY KEY,
  move_date TEXT,
  move_to TEXT,
  relocation_cents INTEGER,
  bonus_cents INTEGER,
  k401_cents INTEGER,
  roth_cents INTEGER,
  updated_at TEXT NOT NULL
);
-- transaction_id is set on rows suggested from a Roth account deposit; dismissed keeps a deleted suggestion from coming back
CREATE TABLE roth_contributions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  tax_year INTEGER NOT NULL,
  transaction_id TEXT UNIQUE,
  dismissed INTEGER NOT NULL DEFAULT 0
);
-- owner-entered tax lots
CREATE TABLE lot_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL,
  acquired_on TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_cents INTEGER NOT NULL
);
ALTER TABLE accounts ADD COLUMN lot_method TEXT CHECK (lot_method IN ('fifo', 'hifo', 'specific'));
ALTER TABLE tax_returns ADD COLUMN capital_loss_carryover_short_cents INTEGER;
ALTER TABLE tax_returns ADD COLUMN capital_loss_carryover_long_cents INTEGER;
