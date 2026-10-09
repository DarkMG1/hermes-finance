-- Who Owes Me: a tagged row or split line is a person's money. Money out = they owe the owner; money in = they repaid.
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  match_text TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
ALTER TABLE transactions ADD COLUMN person_id TEXT REFERENCES people(id);
ALTER TABLE split_lines ADD COLUMN person_id TEXT REFERENCES people(id);
CREATE INDEX transactions_person ON transactions (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX split_lines_person ON split_lines (person_id) WHERE person_id IS NOT NULL;
