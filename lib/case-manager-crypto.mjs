import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('CM01');
const REDACTED = '[REDACTED]';
const SECRET_KEY = /^(?:callback[_-]?signing[_-]?secret|callback[_-]?secret|signing[_-]?secret|master[_-]?key|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|secret)$/i;

export function redactCaseSecrets(value) {
  if (Array.isArray(value)) return value.map(redactCaseSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET_KEY.test(key) ? REDACTED : redactCaseSecrets(item)]));
  return value;
}

function getKey(version, keys) {
  const value = keys?.[version] || process.env[`CASE_MANAGER_DATA_KEY_V${version}_HEX`] || '';
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('case_manager_encryption_unavailable');
  return Buffer.from(value, 'hex');
}

export function encryptCasePayload(payload, { workspaceId, caseId,
  keyVersion = Number(process.env.CASE_MANAGER_ACTIVE_KEY_VERSION || 1), keys } = {}) {
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 255) throw new Error('case_manager_key_version_invalid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(keyVersion, keys), iv);
  cipher.setAAD(Buffer.from(`${workspaceId}:${caseId}`));
  const plain = Buffer.from(JSON.stringify(redactCaseSecrets(payload)), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([keyVersion]), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptCasePayload(bytes, { workspaceId, caseId, keys } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('case_manager_encryption_required');
  const version = bytes[4];
  const decipher = createDecipheriv('aes-256-gcm', getKey(version, keys), bytes.subarray(5, 17));
  decipher.setAAD(Buffer.from(`${workspaceId}:${caseId}`));
  decipher.setAuthTag(bytes.subarray(17, 33));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(33)), decipher.final()]).toString('utf8'));
}
