ALTER TABLE transactions ADD COLUMN payee_owner_set INTEGER NOT NULL DEFAULT 0 CHECK (payee_owner_set IN (0, 1));
