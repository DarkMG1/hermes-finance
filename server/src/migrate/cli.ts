import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { migrate, openDb } from '../db.ts';
import { loadActualSnapshot } from './actual.ts';
import { MigrationError } from './import.ts';
import { mappingSkeleton, parseMapping } from './mapping.ts';
import { formatReport, runMigration } from './run.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'init-mapping': { type: 'string' }, mapping: { type: 'string' }, cutover: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }, apply: { type: 'boolean', default: false }, adjust: { type: 'boolean', default: false },
    },
  });
  const dbPath = process.env.HERMES_DB_PATH;
  if (!dbPath) throw new MigrationError('HERMES_DB_PATH is required');

  const init = values['init-mapping'];
  if (init) {
    if (existsSync(init)) throw new MigrationError(`${init} already exists`);
    if (!existsSync(dbPath)) throw new MigrationError(`no Hermes database at ${dbPath}`);
    const snapshot = await loadActualSnapshot(process.env);
    const db = openDb(dbPath);
    try {
      const hermes = db.prepare('SELECT id, name, mask, type FROM accounts ORDER BY name, id').all() as { id: string; name: string; mask: string | null; type: string }[];
      writeFileSync(init, `${JSON.stringify(mappingSkeleton(snapshot, hermes), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    } finally {
      db.close();
    }
    console.log(`[hermes] wrote ${init}: set every "to" to a Hermes account id, "new" or "skip"`);
    return;
  }

  if (values['dry-run'] === values.apply) throw new MigrationError('pass exactly one of --dry-run or --apply');
  if (!values.mapping || !values.cutover) throw new MigrationError('--mapping and --cutover are required');
  const { mapping, cutovers } = parseMapping(readFileSync(values.mapping, 'utf8'));
  if (!existsSync(dbPath)) throw new MigrationError(`no Hermes database at ${dbPath}`);
  const snapshot = await loadActualSnapshot(process.env);
  const db = openDb(dbPath);
  try {
    migrate(db);
    console.log(formatReport(runMigration(db, snapshot, mapping, { cutoverDate: values.cutover, cutovers, adjust: values.adjust, apply: values.apply, now: new Date() })));
  } finally {
    db.close();
  }
}

main().catch((e: unknown) => {
  const err = e as Error;
  console.error(`[hermes] migrate: ${e instanceof MigrationError ? err.message : `${err.name}: ${err.message}`}`);
  process.exit(1);
});
