-- Receipt itemizing: Claude reads the receipt photo into items; the owner says who had each one.
CREATE TABLE receipt_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,   -- line total; a discount is negative
  people TEXT NOT NULL             -- JSON array of "me" and/or person ids, at least one
);
CREATE INDEX receipt_items_txn ON receipt_items(transaction_id, position);

ALTER TABLE receipts ADD COLUMN tax_cents INTEGER;
ALTER TABLE receipts ADD COLUMN tip_cents INTEGER;
ALTER TABLE receipts ADD COLUMN fees_cents INTEGER;
ALTER TABLE receipts ADD COLUMN total_cents INTEGER;   -- the printed total as read; informational
ALTER TABLE receipts ADD COLUMN read_at TEXT;
ALTER TABLE receipts ADD COLUMN model TEXT;
ALTER TABLE receipts ADD COLUMN applied_lines TEXT;    -- JSON of the lines the last items save left behind
