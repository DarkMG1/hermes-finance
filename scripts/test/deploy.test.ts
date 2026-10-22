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
[ "$scenario" != unknown-before ] || before=unknown
port=5010
stopped=0
stops=0
[ "$scenario" != env-fails ] || mkdir "$root/release.env"
systemctl() {
  echo "service:$2" >> "$root/trace"
  if [ "$2" = stop ]; then
    stops=$((stops + 1))
    [ "$scenario" != stop-fails ] || return 1
    [ "$scenario:$stops" != recovery-stop-fails:2 ] || return 1
    stopped=1
  elif [ "$2" = start ]; then
    stopped=0
  fi
  [ "$scenario:$2" != start-fails:start ]
}
schema_version() {
  echo "schema:$stopped" >> "$root/trace"
  if [ "$scenario" = unknown-after ]; then echo unknown
  elif [ "$scenario:$stopped" = migration:1 ]; then echo 23; else echo 22; fi
}
ln() { echo switch >> "$root/trace"; [ "$scenario" != switch-fails ]; }
mv() { echo move >> "$root/trace"; [ "$scenario" != move-fails ]; }
curl() {
  echo health >> "$root/trace"
  if [ "$scenario" = unhealthy ] || [ "$scenario" = recovery-stop-fails ]; then echo '{"gitSha":"new"}'; else echo '{"gitSha":"old"}'; fi
}
sleep() { :; }
${rollback}
` });
    return { ...result, root: dir, trace: readFileSync(join(dir, 'trace'), 'utf8').trim().split('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('rollback stops the migrating server before reading its final schema', () => {
  const r = runRollback('migration');
  assert.equal(r.status, 1);
  assert.deepEqual(r.trace.slice(0, 2), ['service:stop', 'schema:1']);
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
  for (const scenario of ['stop-fails', 'switch-fails', 'move-fails', 'start-fails', 'unhealthy']) {
    const r = runRollback(scenario);
    assert.equal(r.status, 1, scenario);
    assert.match(r.stderr, /rollback failed/, scenario);
    assert.doesNotMatch(r.stderr, /rolled back/, scenario);
    if (scenario === 'stop-fails') assert.deepEqual(r.trace, ['service:stop']);
    if (scenario === 'switch-fails') assert.deepEqual(r.trace.slice(0, 3), ['service:stop', 'schema:1', 'switch']);
  }
});

test('every failed recovery after stopping reports the stopped service and exact restart commands for both releases', () => {
  for (const scenario of ['migration', 'unknown-before', 'unknown-after', 'switch-fails', 'move-fails', 'env-fails', 'start-fails', 'unhealthy']) {
    const r = runRollback(scenario);
    assert.equal(r.status, 1, scenario);
    assert.match(r.stderr, /hermes\.service is stopped/, scenario);
    for (const release of ['old', 'new']) {
      assert.ok(r.stderr.includes(`ln -sfn '${r.root}/releases/${release}' '${r.root}/current.new' && mv -T '${r.root}/current.new' '${r.root}/current' && printf 'HERMES_GIT_SHA=%s\\n' '${release}' > '${r.root}/release.env' && systemctl --user start hermes.service`), scenario);
    }
    if (scenario.startsWith('unknown')) {
      assert.match(r.stderr, /could not read the schema version/, scenario);
      assert.doesNotMatch(r.stderr, /schema changed unknown|schema changed \d+ -> unknown/, scenario);
    }
    assert.equal(r.trace.at(-1), 'service:stop', scenario);
  }
});

test('a failed recovery stop reports uncertainty instead of claiming the service is stopped', () => {
  const r = runRollback('recovery-stop-fails');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not confirm hermes\.service is stopped/);
  assert.doesNotMatch(r.stderr, /^deploy: hermes\.service is stopped$/m);
  assert.match(r.stderr, /restart previous release/);
  assert.match(r.stderr, /restart new release/);
});
