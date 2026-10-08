import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^hermes-\d{8}T\d{6}Z\.db\.age$/;

export function backupName(now: Date): string {
  return `hermes-${now.toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, '')}.db.age`;
}

// Throws unless `path` is an intact Hermes database (has the migrations table).
function assertIntact(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('integrity check failed');
    db.prepare('SELECT MAX(version) FROM migrations').get();
  } finally {
    db.close();
  }
}

export async function createBackup(opts: { dbPath: string; dir: string; recipient: string; now: Date }): Promise<string> {
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const final = join(opts.dir, backupName(opts.now));
  if (existsSync(final)) throw new Error('a backup with this timestamp already exists');
  const tmp = `${final}.tmp-db`;
  const partial = `${final}.partial`;
  try {
    // separate read-only connection: safe while the server writes; includes committed WAL frames
    const src = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
    try {
      await src.backup(tmp);
    } finally {
      src.close();
    }
    assertIntact(tmp);
    execFileSync('age', ['-r', opts.recipient, '-o', partial, tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    renameSync(partial, final);
    return final;
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${tmp}${suffix}`, { force: true });
    rmSync(partial, { force: true });
  }
}

export function pruneBackups(dir: string, keepDaily = 14, keepMonthly = 12): string[] {
  const names = readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse();
  const keep = new Set<string>();
  const days = new Set<string>();
  for (const n of names) {
    const day = n.slice(7, 15); // YYYYMMDD after "hermes-"
    if (days.has(day)) continue;
    if (days.size >= keepDaily) break;
    days.add(day);
    keep.add(n);
  }
  const months = new Set<string>();
  for (const n of names) {
    const month = n.slice(7, 13); // YYYYMM after "hermes-"
    if (months.has(month)) continue;
    if (months.size >= keepMonthly) break;
    months.add(month);
    keep.add(n);
  }
  const removed = names.filter((n) => !keep.has(n));
  for (const n of removed) rmSync(join(dir, n));
  return removed;
}

export function restoreBackup(opts: { archive: string; identity: string; out: string }): void {
  if (existsSync(opts.out)) throw new Error(`refusing to overwrite ${opts.out}`);
  const partial = `${opts.out}.partial`;
  try {
    execFileSync('age', ['-d', '-i', opts.identity, '-o', partial, opts.archive], { stdio: ['ignore', 'ignore', 'pipe'] });
    assertIntact(partial);
    renameSync(partial, opts.out);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${partial}${suffix}`, { force: true });
  }
}
