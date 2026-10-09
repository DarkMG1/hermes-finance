-- Who Owes Me: the owner said a deposit is not a repayment, so it is never suggested again.
ALTER TABLE transactions ADD COLUMN repayment_dismissed INTEGER NOT NULL DEFAULT 0;
