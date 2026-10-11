CREATE TABLE securities (
  id TEXT PRIMARY KEY,
  name TEXT,
  ticker TEXT,
  type TEXT,
  is_cash INTEGER NOT NULL DEFAULT 0,
  close_price_cents INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE holdings (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  quantity REAL NOT NULL,
  price_cents INTEGER NOT NULL,
  value_cents INTEGER NOT NULL,
  cost_basis_cents INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, security_id)
);
CREATE TABLE holding_snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  date TEXT NOT NULL,
  quantity REAL NOT NULL,
  value_cents INTEGER NOT NULL,
  PRIMARY KEY (account_id, security_id, date)
);
CREATE TABLE holding_syncs (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (account_id, date)
);
ALTER TABLE items ADD COLUMN investments_status TEXT CHECK (investments_status IN ('ok', 'consent_required', 'not_supported'));
