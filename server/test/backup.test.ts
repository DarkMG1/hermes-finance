import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupName, createBackup, pruneBackups, restoreBackup } from '../src/backup.ts';
import { makeTestDeps, seedAccount, seedTxn } from './helpers.ts';

function ageKeys(dir: string, name = 'identity.txt'): { identity: string; recipient: string } {
  const identity = join(dir, name);
  execFileSync('age-keygen', ['-o', identity], { stdio: 'ignore' });
  return { identity, recipient: execFileSync('age-keygen', ['-y', identity], { encoding: 'utf8' }).trim() };
}

async function liveDbWithBackup() {
  const { deps } = makeTestDeps();
  seedAccount(deps.db, { id: 'a1' });
  // written through the open WAL connection and not checkpointed: the backup must still contain it
  seedTxn(deps.db, { id: 't1', accountId: 'a1', date: '2026-01-02', amountCents: -1234 });
  const dir = mkdtempSync(join(tmpdir(), 'hermes-backup-'));
  const keys = ageKeys(dir);
  const out = join(dir, 'backups');
  const file = await createBackup({ dbPath: deps.config.dbPath, dir: out, recipient: keys.recipient, now: new Date('2026-10-08T03:45:00Z') });
  return { deps, dir, out, file, ...keys };
}

test('backupName is a sortable UTC stamp', () => {
  assert.equal(backupName(new Date('2026-10-08T03:45:07.123Z')), 'hermes-20261008T034507Z.db.age');
});

test('backup of a live WAL database round-trips through age and restore', async () => {
  const { dir, out, file, identity } = await liveDbWithBackup();
  assert.equal(file, join(out, 'hermes-20261008T034500Z.db.age'));
  assert.deepEqual(readdirSync(out), ['hermes-20261008T034500Z.db.age']); // no tmp/partial leftovers
  assert.ok(!readFileSync(file).includes('SQLite format 3'), 'archive must be encrypted');
  const restored = join(dir, 'restored.db');
  restoreBackup({ archive: file, identity, out: restored });
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.partial')), []);
  const db = new Database(restored, { readonly: true });
  const row = db.prepare('SELECT amount_cents FROM transactions WHERE id = ?').get('t1') as { amount_cents: number };
  db.close();
  assert.equal(row.amount_cents, -1234);
});

test('restore refuses to overwrite an existing file and leaves it untouched', async () => {
  const { dir, file, identity } = await liveDbWithBackup();
  const target = join(dir, 'live.db');
  writeFileSync(target, 'keep');
  assert.throws(() => restoreBackup({ archive: file, identity, out: target }), /refusing to overwrite/);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('restore with the wrong identity fails and leaves no output behind', async () => {
  const { dir, file } = await liveDbWithBackup();
  const other = ageKeys(dir, 'other.txt');
  const target = join(dir, 'nope.db');
  assert.throws(() => restoreBackup({ archive: file, identity: other.identity, out: target }));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(`${target}.partial`), false);
});

test('backup refuses a database path that does not exist instead of creating an empty one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-backup-'));
  const { recipient } = ageKeys(dir);
  await assert.rejects(createBackup({ dbPath: join(dir, 'missing.db'), dir: join(dir, 'b'), recipient, now: new Date() }));
  assert.equal(existsSync(join(dir, 'missing.db')), false);
});

test('prune keeps the 14 newest plus the newest of each of the last 12 months, and ignores other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-prune-'));
  mkdirSync(dir, { recursive: true });
  for (let t = Date.UTC(2025, 0, 1); t <= Date.UTC(2026, 2, 15); t += 86_400_000) {
    writeFileSync(join(dir, backupName(new Date(t + 3.5 * 3_600_000))), '');
  }
  writeFileSync(join(dir, 'notes.txt'), 'not a backup');
  pruneBackups(dir);
  const left = readdirSync(dir).sort();
  assert.ok(left.includes('notes.txt'));
  const kept = left.filter((n) => n !== 'notes.txt');
  // 14 daily (2026-03-02..15) + month-ends 2026-02 back to 2025-04 (11) = 25
  assert.equal(kept.length, 25);
  assert.ok(kept.includes('hermes-20260302T033000Z.db.age'));
  assert.ok(!kept.includes('hermes-20260301T033000Z.db.age'));
  assert.ok(kept.includes('hermes-20250430T033000Z.db.age'));
  assert.ok(!kept.includes('hermes-20250331T033000Z.db.age'));
});

test('prune counts days, not files: extra same-day archives do not shrink the daily window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-prune-'));
  for (let d = 1; d <= 20; d += 1) writeFileSync(join(dir, backupName(new Date(Date.UTC(2026, 2, d, 3, 30)))), '');
  for (const h of [9, 15]) writeFileSync(join(dir, backupName(new Date(Date.UTC(2026, 2, 20, h)))), '');
  for (const h of [9, 15]) writeFileSync(join(dir, backupName(new Date(Date.UTC(2026, 2, 10, h)))), '');
  pruneBackups(dir);
  const kept = readdirSync(dir).sort();
  // newest of each of 2026-03-07..20 (14 days); March's newest is the 20th's 15:00 archive
  assert.equal(kept.length, 14);
  assert.ok(kept.includes('hermes-20260307T033000Z.db.age'));
  assert.ok(!kept.includes('hermes-20260306T033000Z.db.age'));
  assert.ok(kept.includes('hermes-20260320T150000Z.db.age'));
  assert.ok(!kept.includes('hermes-20260320T090000Z.db.age'));
  assert.ok(!kept.includes('hermes-20260320T033000Z.db.age'));
  assert.ok(kept.includes('hermes-20260310T150000Z.db.age'));
  assert.ok(!kept.includes('hermes-20260310T033000Z.db.age'));
});
