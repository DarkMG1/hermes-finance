-- a job's W-4: only the latest one applies, so one per job
CREATE TABLE w4s (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  signed_on TEXT,
  filing_status TEXT CHECK (filing_status IN ('single', 'married_joint', 'head_of_household')),
  multiple_jobs INTEGER,
  dependents_cents INTEGER,
  other_income_cents INTEGER,
  deductions_cents INTEGER,
  extra_withholding_cents INTEGER,
  exempt INTEGER,
  updated_at TEXT NOT NULL
);
