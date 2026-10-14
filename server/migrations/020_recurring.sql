-- Recurring charges: Plaid's outflow streams (refreshed per Item after sync), the owner's overrides, and hand-marked items.
CREATE TABLE recurring_streams (
  stream_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL,
  average_cents INTEGER NOT NULL,
  last_cents INTEGER NOT NULL,
  last_date TEXT NOT NULL,
  next_date TEXT,
  is_active INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE recurring_overrides (
  stream_id TEXT PRIMARY KEY,
  hidden INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  frequency TEXT
);
CREATE TABLE recurring_manual (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  match_text TEXT NOT NULL,
  frequency TEXT NOT NULL,
  source_transaction_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
