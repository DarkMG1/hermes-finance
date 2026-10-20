-- Names left out of a payee's History (both normalized), and bills ended by hand: ended while the last charge is on or before ended_on.
CREATE TABLE history_exclusions (
  payee_key TEXT NOT NULL,
  excluded_key TEXT NOT NULL,
  PRIMARY KEY (payee_key, excluded_key)
);
ALTER TABLE recurring_manual ADD COLUMN ended_on TEXT;
ALTER TABLE recurring_overrides ADD COLUMN ended_on TEXT;
