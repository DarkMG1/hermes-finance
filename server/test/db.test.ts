import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../src/db.ts';

function tempDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'hermes-db-')), 'test.db'));
}

test('migrate creates the schema and is idempotent', () => {
  const db = tempDb();
  assert.equal(migrate(db), 7);
  assert.equal(migrate(db), 7);
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

test('migration 003 rebuilds transactions without losing rows or split lines and leaves foreign keys on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-m3-'));
  const db = openDb(join(dir, 'h.db'));
  const m = join(import.meta.dirname, '..', 'migrations');
  db.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const [v, f] of [[1, '001_init.sql'], [2, '002_account_cutover.sql']] as const) {
    db.exec(readFileSync(join(m, f), 'utf8'));
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(v, 'x');
  }
  db.prepare("INSERT INTO accounts (id, name, type) VALUES ('a1', 'Synthetic', 'credit')").run();
  db.prepare("INSERT INTO transactions (id, account_id, source, source_id, date, amount_cents, created_at, updated_at) VALUES ('t1', 'a1', 'actual', 's1', '2026-01-01', -500, 'x', 'x')").run();
  db.prepare("INSERT INTO split_lines (id, transaction_id, amount_cents) VALUES ('l1', 't1', -500)").run();

  assert.equal(migrate(db), 7);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT transaction_id FROM split_lines WHERE id = 'l1'").get() as { transaction_id: string }).transaction_id, 't1');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.prepare("INSERT INTO transactions (id, account_id, source, source_id, date, amount_cents, created_at, updated_at) VALUES ('t2', 'a1', 'applecard', 'x1', '2026-01-02', -1, 'x', 'x')").run();
  assert.throws(() => db.prepare("INSERT INTO transactions (id, account_id, source, date, amount_cents, created_at, updated_at) VALUES ('t3', 'a1', 'bogus', '2026-01-02', -1, 'x', 'x')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO split_lines (id, transaction_id, amount_cents) VALUES ('l2', 'missing', 1)").run(), /FOREIGN KEY/);
  db.prepare("DELETE FROM transactions WHERE id = 't1'").run();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM split_lines').get() as { n: number }).n, 0, 'cascade still works');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'transactions_account_date'").get());
});

test('migration 004 protects bank rows a stored PATCH response shows uncategorized, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-m4-'));
  const db = openDb(join(dir, 'h.db'));
  const m = join(import.meta.dirname, '..', 'migrations');
  db.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const [v, f] of [[1, '001_init.sql'], [2, '002_account_cutover.sql']] as const) {
    db.exec(readFileSync(join(m, f), 'utf8'));
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(v, 'x');
  }
  db.prepare("INSERT INTO accounts (id, name, type) VALUES ('a1', 'Synthetic', 'credit')").run();
  const txn = db.prepare("INSERT INTO transactions (id, account_id, source, source_id, date, amount_cents, category_id, created_at, updated_at) VALUES (?, 'a1', ?, ?, '2026-01-01', -1, NULL, 'x', 'x')");
  for (const [id, source] of [['cleared', 'plaid'], ['untouched', 'plaid'], ['manual', 'manual']] as const) txn.run(id, source, id);
  db.prepare("UPDATE transactions SET removed_at = 'x' WHERE id = 'cleared'").run();
  db.prepare("INSERT INTO transactions (id, account_id, source, source_id, pending_source_id, date, amount_cents, created_at, updated_at) VALUES ('posted', 'a1', 'plaid', 'posted', 'cleared', '2026-01-02', -1, 'x', 'x')").run();
  const key = db.prepare("INSERT INTO idempotency_keys (key, request_hash, status_code, response_json, created_at) VALUES (?, 'h', 200, ?, 'x')");
  key.run('k1', JSON.stringify({ id: 'cleared', source: 'plaid', categoryId: null }));
  key.run('k2', JSON.stringify({ id: 'manual', source: 'manual', categoryId: null }));
  key.run('k3', JSON.stringify({ ok: true }));
  key.run('k4', '{not-json');

  assert.equal(migrate(db), 7);
  const flag = (id: string) => (db.prepare('SELECT category_owner_set AS f FROM transactions WHERE id = ?').get(id) as { f: number }).f;
  assert.deepEqual(['cleared', 'posted', 'untouched', 'manual'].map(flag), [1, 1, 0, 0]);
});
