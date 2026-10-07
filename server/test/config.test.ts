import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

const base = {
  HERMES_API_TOKEN: 'a'.repeat(32), HERMES_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'),
  HERMES_DB_PATH: ':memory:', PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox',
};

test('defaults load', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 5010);
  assert.equal(c.syncIntervalMs, 21600000);
});

test('valid overrides load', () => {
  const c = loadConfig({ ...base, HERMES_PORT: '0', HERMES_SYNC_INTERVAL_MS: '60000' });
  assert.equal(c.port, 0);
  assert.equal(c.syncIntervalMs, 60000);
});

test('bad port is rejected without echoing the value', () => {
  for (const bad of ['abc', '70000', '-1', '1.5', '']) {
    assert.throws(() => loadConfig({ ...base, HERMES_PORT: bad }), (e: Error) => /HERMES_PORT/.test(e.message) && (bad === '' || !e.message.includes(bad)));
  }
});

test('bad sync interval is rejected without echoing the value', () => {
  for (const bad of ['0', '', 'abc', '3000000000', '59999']) {
    assert.throws(() => loadConfig({ ...base, HERMES_SYNC_INTERVAL_MS: bad }), (e: Error) => /HERMES_SYNC_INTERVAL_MS/.test(e.message) && (bad === '' || !e.message.includes(bad)));
  }
});
