import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM migrations').all().map((r) => (r as { version: number }).version));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // SQLite ignores PRAGMA foreign_keys inside a transaction; table rebuilds need it off around the transaction
    const fkOff = sql.startsWith('-- hermes:foreign-keys-off');
    if (fkOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        if (fkOff && (db.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error(`migration ${file} broke foreign keys`);
        db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      })();
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
  }
  const row = db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null };
  return row.v ?? 0;
}
