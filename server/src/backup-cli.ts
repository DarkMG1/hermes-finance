import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createBackup, pruneBackups, restoreBackup } from './backup.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { archive: { type: 'string' }, identity: { type: 'string' }, out: { type: 'string' } },
  });
  if (positionals[0] === 'backup') {
    const dir = need('HERMES_BACKUP_DIR');
    const file = await createBackup({ dbPath: need('HERMES_DB_PATH'), dir, recipient: need('HERMES_BACKUP_AGE_RECIPIENT'), now: new Date() });
    const removed = pruneBackups(dir);
    console.log(`[hermes] backup ok file=${basename(file)} pruned=${removed.length}`);
  } else if (positionals[0] === 'restore' && values.archive && values.identity && values.out) {
    restoreBackup({ archive: values.archive, identity: values.identity, out: values.out });
    console.log(`[hermes] restore ok out=${values.out}`);
  } else {
    console.error('usage: backup-cli.ts backup | restore --archive <file.db.age> --identity <age identity> --out <new db path>');
    process.exit(2);
  }
}

main().catch((e: unknown) => {
  console.error(`[hermes] backup failed: ${(e as Error).message}`);
  process.exit(1);
});
