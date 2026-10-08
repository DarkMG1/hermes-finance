import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Layout: base64(nonce[12] | ciphertext | tag[16]).
export function encryptToken(plain: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

export function decryptToken(enc: string, key: Buffer): string {
  const raw = Buffer.from(enc, 'base64');
  if (raw.length < 29) throw new Error('encrypted token too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}
