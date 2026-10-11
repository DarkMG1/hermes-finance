-- 1 when the owner changed the date; bank sync and Apple Card re-import then keep it
ALTER TABLE transactions ADD COLUMN date_owner_set INTEGER NOT NULL DEFAULT 0;
