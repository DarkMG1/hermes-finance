import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../src/db.ts';

function tempDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'hermes-db-')), 'test.db'));
}

test('migrate creates the schema and is idempotent', () => {
  const db = tempDb();
  assert.equal(migrate(db), 2);
  assert.equal(migrate(db), 2);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => (r as { name: string }).name);
  for (const t of ['accounts', 'categories', 'idempotency_keys', 'items', 'link_sessions', 'migrations', 'plaid_category_map', 'settings', 'split_lines', 'sync_pages', 'sync_runs', 'transactions']) {
    assert.ok(tables.includes(t), `missing ${t}`);
  }
  assert.ok(db.prepare('PRAGMA table_info(accounts)').all().some((c) => (c as { name: string }).name === 'cutover_date'));
});

test('foreign keys and WAL are on', () => {
  const db = tempDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
});

test('transactions are unique per source id but manual rows may repeat null', () => {
  const db = tempDb();
  migrate(db);
  db.prepare("INSERT INTO accounts (id, name, type) VALUES ('a1','Checking','depository')").run();
  const ins = db.prepare("INSERT INTO transactions (id, account_id, source, source_id, date, amount_cents, created_at, updated_at) VALUES (?, 'a1', ?, ?, '2026-01-01', -100, 'now', 'now')");
  ins.run('t1', 'plaid', 'p1');
  assert.throws(() => ins.run('t2', 'plaid', 'p1'));
  ins.run('t3', 'manual', null);
  ins.run('t4', 'manual', null);
});
