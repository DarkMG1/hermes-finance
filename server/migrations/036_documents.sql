-- Kept documents: the redacted pages of each profile read, linked to the records saved from it. Unlinked ones are purged after 24 hours.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tax_return', 'tax_form', 'pay_stub', 'offer', 'w4', 'state_w4')),
  page_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE document_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  jpeg BLOB NOT NULL,
  PRIMARY KEY (document_id, idx)
);
-- record_id: the row's id; a W-4's is its job id, a state form's is "<job id>:<state>"
CREATE TABLE document_links (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('tax_return', 'tax_form', 'pay_stub', 'job', 'w4', 'state_w4')),
  record_id TEXT NOT NULL,
  PRIMARY KEY (document_id, record_type, record_id)
);
CREATE INDEX document_links_record ON document_links(record_type, record_id);
