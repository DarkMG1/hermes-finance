-- the owner changed a suggested contribution's amount or date: refreshes from its source leave those alone
ALTER TABLE roth_contributions ADD COLUMN owner_edited INTEGER NOT NULL DEFAULT 0;
