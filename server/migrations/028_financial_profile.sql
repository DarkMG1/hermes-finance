CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT,
  filing_status TEXT CHECK (filing_status IN ('single', 'married_joint', 'married_separate', 'head_of_household')),
  birth_year INTEGER,
  dependents INTEGER,
  retirement_pct REAL,
  retirement_kind TEXT CHECK (retirement_kind IN ('pre_tax', 'roth', 'mixed')),
  hsa INTEGER CHECK (hsa IN (0, 1)),
  note TEXT,
  updated_at TEXT
);
INSERT INTO profile (id) VALUES (1);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  employer TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('offered', 'accepted', 'declined', 'current', 'past')),
  start_date TEXT,
  end_date TEXT,
  base_cents INTEGER,
  bonus_target_pct REAL,
  signing_bonus_cents INTEGER,
  relocation_cents INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE equity_grants (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rsu', 'option')),
  shares REAL,
  value_cents INTEGER,
  strike_cents INTEGER,
  grant_date TEXT NOT NULL,
  cliff_months INTEGER NOT NULL,
  vest_months INTEGER NOT NULL,
  vest_every_months INTEGER NOT NULL,
  CHECK (shares IS NOT NULL OR value_cents IS NOT NULL)
);
CREATE INDEX equity_grants_job ON equity_grants(job_id);
CREATE TABLE pay_stubs (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  pay_date TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  gross_cents INTEGER NOT NULL,
  federal_cents INTEGER NOT NULL,
  state_cents INTEGER NOT NULL,
  social_security_cents INTEGER NOT NULL,
  medicare_cents INTEGER NOT NULL,
  retirement_cents INTEGER NOT NULL,
  other_deductions_cents INTEGER NOT NULL,
  -- after-tax additions (reimbursements, stipends): gross - deductions + other pay = net
  other_pay_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  ytd_gross_cents INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX pay_stubs_job ON pay_stubs(job_id);
-- a paycheck split across accounts links each deposit; a deposit belongs to one stub
CREATE TABLE pay_stub_deposits (
  stub_id TEXT NOT NULL REFERENCES pay_stubs(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE
);
CREATE INDEX pay_stub_deposits_stub ON pay_stub_deposits(stub_id);
CREATE TABLE tax_forms (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('w2', '1099_nec', '1099_int', '1099_div', '1099_b', '1099_misc', 'other')),
  payer TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  federal_withheld_cents INTEGER,
  state TEXT,
  state_withheld_cents INTEGER,
  ss_wages_cents INTEGER,
  medicare_wages_cents INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX tax_forms_job ON tax_forms(job_id);
CREATE TABLE tax_returns (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  jurisdiction TEXT NOT NULL,
  filing_status TEXT CHECK (filing_status IN ('single', 'married_joint', 'married_separate', 'head_of_household')),
  wages_cents INTEGER,
  total_income_cents INTEGER,
  agi_cents INTEGER,
  deduction_kind TEXT CHECK (deduction_kind IN ('standard', 'itemized')),
  deduction_cents INTEGER,
  taxable_income_cents INTEGER,
  total_tax_cents INTEGER,
  credits_cents INTEGER,
  withholding_cents INTEGER,
  refund_cents INTEGER,
  capital_gains_cents INTEGER,
  capital_loss_carryover_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (year, jurisdiction)
);
-- SQLite can't alter a CHECK: rebuild ai_usage so it records the profile reader
CREATE TABLE ai_usage_new (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  month TEXT NOT NULL,
  key TEXT NOT NULL CHECK (key IN ('main', 'backup')),
  feature TEXT NOT NULL CHECK (feature IN ('chat', 'receipt', 'profile')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_microdollars INTEGER NOT NULL
);
INSERT INTO ai_usage_new SELECT * FROM ai_usage;
DROP TABLE ai_usage;
ALTER TABLE ai_usage_new RENAME TO ai_usage;
CREATE INDEX ai_usage_month ON ai_usage(month);
-- a question asked while Ask's profile lock was on: its tools refused the profile data
ALTER TABLE chat_messages ADD COLUMN profile_locked INTEGER NOT NULL DEFAULT 0 CHECK (profile_locked IN (0, 1));
-- a chat holding financial profile data, from the first answer that got it (a profile tool, or a past chat that held it) onward;
-- profile_title: its title was written after that, so a locked list doesn't show it
ALTER TABLE chat_conversations ADD COLUMN profile_seq INTEGER;
ALTER TABLE chat_conversations ADD COLUMN profile_title INTEGER NOT NULL DEFAULT 0 CHECK (profile_title IN (0, 1));
