import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtures, FIXTURE_DIR } from '../server/test/fixtures/generate.ts';

const dir = join(import.meta.dirname, '..', FIXTURE_DIR);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
const fixtures = await buildFixtures();
for (const [name, content] of Object.entries(fixtures)) writeFileSync(join(dir, name), content);
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${FIXTURE_DIR}`);
