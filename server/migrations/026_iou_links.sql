CREATE TABLE iou_links (
  id TEXT PRIMARY KEY,
  payback_transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  payback_line_id TEXT REFERENCES split_lines(id) ON DELETE CASCADE,
  item_transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  item_line_id TEXT REFERENCES split_lines(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX iou_links_item ON iou_links(item_transaction_id);
CREATE INDEX iou_links_payback ON iou_links(payback_transaction_id);
