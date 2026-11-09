-- what a return, a pay stub and the owner's profile need for Ask to work out taxes without guessing
-- the return's "someone can claim you as a dependent" box (or a state return's dependent exemption)
ALTER TABLE tax_returns ADD COLUMN claimed_as_dependent INTEGER;
-- the state a stub's income tax went to
ALTER TABLE pay_stubs ADD COLUMN state TEXT;
ALTER TABLE profile ADD COLUMN full_time_student INTEGER;
-- for this year: someone else can claim the owner as a dependent
ALTER TABLE profile ADD COLUMN claimed_as_dependent INTEGER;
