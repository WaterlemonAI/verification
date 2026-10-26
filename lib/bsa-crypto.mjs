import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('BSA1');

function key() {
  const value = process.env.BSA_DATA_KEY_HEX || '';
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('bsa_encryption_unavailable');
  return Buffer.from(value, 'hex');
}

export function encryptBsa(bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBsa(bytes) {
  if (!bytes.subarray(0, 4).equals(MAGIC) || bytes.length < 32) throw new Error('bsa_encryption_required');
  const iv = bytes.subarray(4, 16);
  const tag = bytes.subarray(16, 32);
  const cipher = createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]);
}
