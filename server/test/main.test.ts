import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { migrate, openDb } from '../src/db.ts';
import { start } from '../src/main.ts';

test('start migrates, listens and serves health; refuses bad config', async () => {
  const env = {
    HERMES_DB_PATH: join(mkdtempSync(join(tmpdir(), 'hermes-main-')), 'h.db'),
    HERMES_API_TOKEN: 'x'.repeat(40), HERMES_TOKEN_KEY: randomBytes(32).toString('base64'), HERMES_PORT: '0',
    HERMES_SYNC_INTERVAL_MS: '3600000', PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox', HERMES_GIT_SHA: 'abc',
  };
  // a read never saved, from long ago, and one from just now: startup purges only the old one
  const seed = openDb(env.HERMES_DB_PATH);
  migrate(seed);
  const doc = seed.prepare("INSERT INTO documents (id, kind, page_count, created_at) VALUES (?, 'w4', 0, ?)");
  doc.run('old', '2000-01-01T00:00:00.000Z');
  doc.run('young', new Date().toISOString());
  seed.close();
  const server = await start(env);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
    assert.deepEqual(await res.json(), { ok: true });
    const detailed = await fetch(`http://127.0.0.1:${server.port}/v1/health`, { headers: { authorization: `Bearer ${env.HERMES_API_TOKEN}` } });
    assert.deepEqual(await detailed.json(), { ok: true, gitSha: 'abc', dbVersion: 36 });
  } finally {
    await server.close();
  }
  const after = openDb(env.HERMES_DB_PATH);
  assert.deepEqual(after.prepare('SELECT id FROM documents').pluck().all(), ['young']);
  after.close();
  await assert.rejects(start({ ...env, HERMES_TOKEN_KEY: 'short' }), /32 bytes/);
});
