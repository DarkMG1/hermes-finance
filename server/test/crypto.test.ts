import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptToken, decryptToken } from '../src/crypto.ts';

const key = randomBytes(32);

test('round trip', () => {
  const enc = encryptToken('access-sandbox-123', key);
  assert.notEqual(enc, 'access-sandbox-123');
  assert.equal(decryptToken(enc, key), 'access-sandbox-123');
});

test('each encryption uses a fresh nonce', () => {
  assert.notEqual(encryptToken('same', key), encryptToken('same', key));
});

test('tampering or a wrong key fails loudly', () => {
  const enc = encryptToken('secret', key);
  const bytes = Buffer.from(enc, 'base64');
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  assert.throws(() => decryptToken(bytes.toString('base64'), key));
  assert.throws(() => decryptToken(enc, randomBytes(32)));
});
