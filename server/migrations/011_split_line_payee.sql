-- a split line's own name; NULL shows the transaction's payee
ALTER TABLE split_lines ADD COLUMN payee TEXT;
