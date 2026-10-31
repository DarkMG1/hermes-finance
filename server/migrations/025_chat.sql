CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- one row per bubble. user: content_json = the text as a JSON string. assistant: content_json = the Anthropic messages of
-- that turn in order (assistant, user tool_result, assistant, ...), so the conversation replays unchanged.
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  client_id TEXT UNIQUE,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('streaming', 'done', 'failed', 'stopped')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  month TEXT NOT NULL,
  key TEXT NOT NULL CHECK (key IN ('main', 'backup')),
  feature TEXT NOT NULL CHECK (feature IN ('chat', 'receipt')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_microdollars INTEGER NOT NULL
);
CREATE INDEX ai_usage_month ON ai_usage(month);
CREATE TABLE ai_key_state (month TEXT PRIMARY KEY, backup_active INTEGER NOT NULL);
