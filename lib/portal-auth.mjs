import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createAdminAccount, verifyAdminPassword } from './admin-auth.mjs';

const SESSION_SECONDS = 8 * 60 * 60;

export const PORTAL_COOKIE = 'ai7_portal_session';

function sign(value, key) {
  return createHmac('sha256', key).update(value).digest('base64url');
}

export function createPortalAccount(email, password, client, previous = null) {
  if (!client?.id || !client?.name) throw new Error('An active AI7 workspace is required.');
  return {
    ...createAdminAccount(email, password, previous),
    client_id: String(client.id),
    client_name: String(client.name).slice(0, 100),
    ...(previous?.initial_key_pending ? { initial_key_pending: true } : {})
  };
}

export function verifyPortalPassword(account, email, password) {
  return verifyAdminPassword(account, email, password);
}

export function createPortalSession(account, signingKey, now = Date.now()) {
  const csrfToken = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    email: account.email,
    client_id: account.client_id,
    version: account.version,
    mfa: 'email_otp',
    issued_at: Math.floor(now / 1000),
    expires_at: Math.floor(now / 1000) + SESSION_SECONDS,
    csrf: csrfToken
  })).toString('base64url');
  return { token: `${payload}.${sign(payload, signingKey)}`, csrfToken, expiresIn: SESSION_SECONDS };
}

export function verifyPortalSession(token, account, signingKey, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra || !account || !signingKey) return null;
  const expected = Buffer.from(sign(payload, signingKey));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.email !== account.email || session.client_id !== account.client_id || session.version !== account.version
      || session.mfa !== 'email_otp' || session.expires_at <= Math.floor(now / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export function portalCookie(token, { secure = true, maxAge = SESSION_SECONDS } = {}) {
  return `${PORTAL_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearPortalCookie({ secure = true } = {}) {
  return `${PORTAL_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function safePortalAccount(account) {
  return account ? {
    email: account.email,
    client_id: account.client_id,
    client_name: account.client_name,
    version: account.version,
    updated_at: account.updated_at
  } : null;
}
