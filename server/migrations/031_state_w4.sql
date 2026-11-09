-- a job's state withholding certificates (California's DE-4 and the like): one per state, the latest replacing the one before
CREATE TABLE state_w4s (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  signed_on TEXT,
  filing_status TEXT CHECK (filing_status IN ('single', 'married', 'head_of_household')),
  allowances INTEGER,
  additional_allowances INTEGER,
  extra_withholding_cents INTEGER,
  exempt INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, state)
);
