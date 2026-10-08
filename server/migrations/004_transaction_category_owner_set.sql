-- Owner touched the category (set or cleared it): learned Plaid mappings never fill it.
ALTER TABLE transactions ADD COLUMN category_owner_set INTEGER NOT NULL DEFAULT 0;
-- Before this column, an owner clear left no trace except the stored PATCH response. Protect bank rows that a stored
-- response shows uncategorized and that are still uncategorized (a payee/notes edit also matches; that only skips auto-fill).
UPDATE transactions SET category_owner_set = 1
 WHERE category_id IS NULL AND source IN ('plaid', 'applecard')
   AND id IN (SELECT json_extract(response_json, '$.id') FROM idempotency_keys
               WHERE json_type(response_json, '$.categoryId') = 'null' AND json_extract(response_json, '$.source') IN ('plaid', 'applecard'));
