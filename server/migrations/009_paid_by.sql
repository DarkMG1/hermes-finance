-- Shared balances: someone else paid this manual expense. It is the owner's own spending, and that person's credit.
ALTER TABLE transactions ADD COLUMN paid_by_person_id TEXT REFERENCES people(id);
CREATE INDEX transactions_paid_by ON transactions (paid_by_person_id) WHERE paid_by_person_id IS NOT NULL;
