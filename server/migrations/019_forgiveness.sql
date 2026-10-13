-- Forgiveness: a $0 manual row whose +X line lowers a person's balance and whose −X line is the owner's spending.
ALTER TABLE transactions ADD COLUMN forgiven INTEGER NOT NULL DEFAULT 0;
