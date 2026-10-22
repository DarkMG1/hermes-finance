import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const deploy = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
const rollback = deploy.slice(deploy.indexOf('echo "deploy: /v1/health did not report'), deploy.lastIndexOf('\nREMOTE'));

// Run the real failure branch with fake service, schema, switch and health commands.
function runRollback(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-rollback-'));
  try {
    const result = spawnSync('bash', ['-s', '--', dir, scenario], { encoding: 'utf8', input: `
set -euo pipefail
root="$1"
scenario="$2"
rel="$root/releases/new"
prev="$root/releases/old"
sha=new
before=22
port=5010
stopped=0
systemctl() {
  echo "service:$2" >> "$root/trace"
  if [ "$2" = stop ]; then
    [ "$scenario" != stop-fails ] || return 1
    stopped=1
  fi
  [ "$scenario:$2" != start-fails:start ]
}
schema_version() {
  echo "schema:$stopped" >> "$root/trace"
  if [ "$scenario:$stopped" = migration:1 ]; then echo 23; else echo 22; fi
}
ln() { echo switch >> "$root/trace"; [ "$scenario" != switch-fails ]; }
mv() { echo move >> "$root/trace"; }
curl() {
  echo health >> "$root/trace"
  if [ "$scenario" = unhealthy ]; then echo '{"gitSha":"new"}'; else echo '{"gitSha":"old"}'; fi
}
sleep() { :; }
${rollback}
` });
    return { ...result, trace: readFileSync(join(dir, 'trace'), 'utf8').trim().split('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('rollback stops the migrating server before reading its final schema', () => {
  const r = runRollback('migration');
  assert.equal(r.status, 1);
  assert.deepEqual(r.trace, ['service:stop', 'schema:1']);
  assert.match(r.stderr, /schema changed 22 -> 23/);
  assert.doesNotMatch(r.stderr, /rolled back/);
});

test('rollback reports success only after switching, starting and verifying the previous release', () => {
  const r = runRollback('healthy');
  assert.equal(r.status, 1, 'the failed deployment still exits unsuccessfully');
  assert.deepEqual(r.trace, ['service:stop', 'schema:1', 'switch', 'move', 'service:start', 'health']);
  assert.match(r.stderr, /rolled back to old/);
});

test('rollback stop, switch, start and health failures never report success', () => {
  for (const scenario of ['stop-fails', 'switch-fails', 'start-fails', 'unhealthy']) {
    const r = runRollback(scenario);
    assert.equal(r.status, 1, scenario);
    assert.match(r.stderr, /rollback failed/, scenario);
    assert.doesNotMatch(r.stderr, /rolled back/, scenario);
    if (scenario === 'stop-fails') assert.deepEqual(r.trace, ['service:stop']);
    if (scenario === 'switch-fails') assert.deepEqual(r.trace, ['service:stop', 'schema:1', 'switch']);
  }
});
