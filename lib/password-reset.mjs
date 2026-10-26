import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RESET_MINUTES = 30;

function signature(payload, key) {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function createPasswordResetToken({ kind, account, signingKey, now = Date.now() }) {
  if (!['admin', 'portal'].includes(kind) || !account?.email || !signingKey) throw new Error('password_reset_unavailable');
  const payload = Buffer.from(JSON.stringify({
    kind, email: account.email, version: account.version,
    expires_at: Math.floor(now / 1000) + RESET_MINUTES * 60,
    nonce: randomBytes(16).toString('base64url')
  })).toString('base64url');
  return `${payload}.${signature(payload, signingKey)}`;
}

export function parsePasswordResetToken(token, { kind, signingKey, now = Date.now() }) {
  const [payload, supplied, extra] = String(token || '').split('.');
  if (!payload || !supplied || extra || !signingKey || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(supplied)) return null;
  const expected = Buffer.from(signature(payload, signingKey));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.kind !== kind || !Number.isSafeInteger(data.version) || !Number.isSafeInteger(data.expires_at)
      || data.expires_at <= Math.floor(now / 1000) || data.expires_at > Math.floor(now / 1000) + RESET_MINUTES * 60
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || '')) return null;
    return data;
  } catch { return null; }
}
