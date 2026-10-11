-- one balance per account per local day; the last sync of the day wins
CREATE TABLE balance_snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  PRIMARY KEY (account_id, date)
);
