ALTER TABLE inbox_receipts ADD COLUMN for_person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
