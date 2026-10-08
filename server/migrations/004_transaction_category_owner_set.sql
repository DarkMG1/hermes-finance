-- Owner touched the category (set or cleared it): learned Plaid mappings never fill it.
ALTER TABLE transactions ADD COLUMN category_owner_set INTEGER NOT NULL DEFAULT 0;
-- Before this column, an owner clear left no trace except the stored PATCH response. Protect bank rows that a stored
-- response shows uncategorized and that are still uncategorized (a payee/notes edit also matches; that only skips auto-fill).
-- CASE guards keep a malformed cached response from aborting the migration.
UPDATE transactions SET category_owner_set = 1
 WHERE category_id IS NULL AND source IN ('plaid', 'applecard')
   AND id IN (SELECT CASE WHEN json_valid(response_json) THEN json_extract(response_json, '$.id') END FROM idempotency_keys
               WHERE CASE WHEN json_valid(response_json) THEN json_type(response_json, '$.categoryId') = 'null'
                       AND json_extract(response_json, '$.source') IN ('plaid', 'applecard') END);
-- A cleared pending row that has since posted: its posted successor inherits the protection.
UPDATE transactions SET category_owner_set = 1
 WHERE category_id IS NULL AND source = 'plaid' AND category_owner_set = 0
   AND pending_source_id IN (SELECT source_id FROM transactions WHERE source = 'plaid' AND category_owner_set = 1);
