-- Apple Card: an identical purchase that cleared on another day (often in another statement) is a different charge
ALTER TABLE transactions ADD COLUMN clearing_date TEXT;
