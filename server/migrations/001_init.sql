CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  plaid_item_id TEXT NOT NULL UNIQUE,
  institution_name TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'login_required', 'error')),
  last_error_code TEXT,
  last_synced_at TEXT
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id),
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  balance_current_cents INTEGER,
  balance_available_cents INTEGER,
  balance_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  group_name TEXT NOT NULL,
  is_income INTEGER NOT NULL DEFAULT 0,
  is_transfer INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('plaid', 'manual', 'actual')),
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
CREATE INDEX transactions_date ON transactions (date DESC, id DESC);
CREATE INDEX transactions_account_date ON transactions (account_id, date);

CREATE TABLE split_lines (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  category_id TEXT REFERENCES categories(id),
  notes TEXT
);
CREATE INDEX split_lines_txn ON split_lines (transaction_id);

CREATE TABLE plaid_category_map (
  plaid_category TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id)
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE link_sessions (
  id TEXT PRIMARY KEY,
  link_token TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('create', 'update')),
  item_id TEXT REFERENCES items(id),
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE TABLE sync_pages (
  id INTEGER PRIMARY KEY,
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  page_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
