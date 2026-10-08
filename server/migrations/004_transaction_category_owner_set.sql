-- Owner touched the category (set or cleared it): learned Plaid mappings never fill it.
ALTER TABLE transactions ADD COLUMN category_owner_set INTEGER NOT NULL DEFAULT 0;
