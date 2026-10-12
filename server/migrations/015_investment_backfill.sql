CREATE TABLE investment_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  quantity REAL NOT NULL,
  amount_cents INTEGER NOT NULL,
  price_cents INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX investment_transactions_account_date ON investment_transactions (account_id, date);
CREATE TABLE security_prices (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close_cents INTEGER NOT NULL,
  split_factor REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (ticker, date)
);
