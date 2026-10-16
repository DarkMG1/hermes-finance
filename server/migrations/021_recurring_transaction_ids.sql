-- Plaid's transaction ids per stream, so a bill's History lists exactly its charges whatever they're named.
ALTER TABLE recurring_streams ADD COLUMN transaction_ids TEXT NOT NULL DEFAULT '[]';
