-- The bank's own date, kept under an owner-set date so "Use bank date" can restore it; manual and Actual rows have none.
ALTER TABLE transactions ADD COLUMN bank_date TEXT;
-- The newest Apple Card statement that set the row, and that statement's clearing-date range.
ALTER TABLE transactions ADD COLUMN source_file_date TEXT;
ALTER TABLE transactions ADD COLUMN source_clear_from TEXT;
ALTER TABLE transactions ADD COLUMN source_clear_to TEXT;
UPDATE transactions SET bank_date = date WHERE date_owner_set = 0 AND source IN ('plaid', 'applecard');
-- Apple Card has always stored the transaction date in authorized_date, so a row the owner re-dated still knows its bank date.
UPDATE transactions SET bank_date = authorized_date WHERE source = 'applecard' AND date_owner_set = 1 AND bank_date IS NULL;
-- Each imported Apple Card file, by the hash of its rows: importing one again changes nothing.
CREATE TABLE applecard_imports (hash TEXT PRIMARY KEY, imported_at TEXT NOT NULL);
