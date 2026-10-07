import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { start } from '../src/main.ts';

test('start migrates, listens and serves health; refuses bad config', async () => {
  const env = {
    HERMES_DB_PATH: join(mkdtempSync(join(tmpdir(), 'hermes-main-')), 'h.db'),
    HERMES_API_TOKEN: 'x'.repeat(40), HERMES_TOKEN_KEY: randomBytes(32).toString('base64'), HERMES_PORT: '0',
    HERMES_SYNC_INTERVAL_MS: '3600000', PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox', HERMES_GIT_SHA: 'abc',
  };
  const server = await start(env);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
    assert.deepEqual(await res.json(), { ok: true, gitSha: 'abc', dbVersion: 1 });
  } finally {
    await server.close();
  }
  await assert.rejects(start({ ...env, HERMES_TOKEN_KEY: 'short' }), /32 bytes/);
});
