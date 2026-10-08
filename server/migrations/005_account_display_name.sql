-- Owner's name for an account; sync never touches it. NULL shows the bank's name.
ALTER TABLE accounts ADD COLUMN display_name TEXT;
