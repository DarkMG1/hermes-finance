import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findPersonalData, parseDenylist } from '../check-personal-data.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('CI containers are pinned by digest', () => {
  const workflow = read('.github/workflows/ci.yml');
  const images = [...workflow.matchAll(/(?:container:\s*|\/work\s+)((?:ghcr\.io\/realm\/swiftlint|swift):[^\s]+)/g)].map((m) => m[1]);
  assert.equal(images.length, 2);
  for (const image of images) assert.match(image!, /@sha256:[a-f0-9]{64}$/);
});

test('hooks and CI scan lockfile contents through stdin to bypass inherited path exclusions', () => {
  assert.match(read('.githooks/pre-commit'), /git show :package-lock\.json/);
  assert.match(read('.githooks/pre-commit'), /gitleaks stdin --no-banner --redact/);
  assert.match(read('.github/workflows/ci.yml'), /gitleaks stdin --no-banner --redact < package-lock\.json/);
});

test('the current lockfile passes the personal-data rules', () => {
  const denylist = process.env['HERMES_DENYLIST'] ?? join(homedir(), '.config/hermes/personal-denylist.txt');
  // CI has no owner denylist; email checks still run there.
  let terms: string[] = [];
  try { terms = parseDenylist(readFileSync(denylist, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  assert.deepEqual(findPersonalData([{ path: 'package-lock.json', content: read('package-lock.json') }], terms), []);
});

test('gitleaks stdin scans the current lockfile and detects a synthetic credential in lockfile JSON', (t) => {
  const args = ['stdin', '--no-banner', '--redact', '--log-level', 'error'];
  const clean = spawnSync('gitleaks', args, { encoding: 'utf8', input: read('package-lock.json') });
  if (clean.error && (clean.error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('gitleaks is installed separately in CI'); return; }
  assert.equal(clean.status, 0, clean.stderr);
  const credential = 'gh' + 'p_' + 'SyntheticQuillWrenMossFern0123456789AB'.slice(0, 36);
  const infected = spawnSync('gitleaks', args, { encoding: 'utf8', input: JSON.stringify({ packages: { synthetic: { resolved: `https://${credential}@example.test/package.tgz` } } }) });
  assert.equal(infected.status, 1, infected.stderr);
});
