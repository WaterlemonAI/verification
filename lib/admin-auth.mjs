import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_SECONDS = 8 * 60 * 60;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_ACCOUNT = {
  email: 'invalid@ai7.local',
  password_algorithm: 'scrypt-v1',
  password_salt: 'HTuc12lbYZ0TZhK9KMvNLQ',
  password_hash: scryptSync('not-a-real-password', 'HTuc12lbYZ0TZhK9KMvNLQ', 64, SCRYPT_OPTIONS).toString('base64url')
};

export const ADMIN_COOKIE = 'ai7_admin_session';

export function normalizeAdminEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateAdminCredentials(email, password) {
  const normalizedEmail = normalizeAdminEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw new Error('Enter a valid email address.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error('Password must include uppercase, lowercase, number, and symbol characters.');
  }
  return normalizedEmail;
}

export function createAdminAccount(email, password, previous = null) {
  const normalizedEmail = validateAdminCredentials(email, password);
  const salt = randomBytes(16).toString('base64url');
  const passwordHash = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('base64url');
  const timestamp = new Date().toISOString();
  return {
    email: normalizedEmail,
    password_algorithm: 'scrypt-v1',
    password_salt: salt,
    password_hash: passwordHash,
    version: Number(previous?.version || 0) + 1,
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp
  };
}

export function verifyAdminPassword(account, email, password) {
  const candidate = account?.password_algorithm === 'scrypt-v1' ? account : DUMMY_ACCOUNT;
  const calculated = scryptSync(typeof password === 'string' ? password : '', candidate.password_salt, 64, SCRYPT_OPTIONS);
  const expected = Buffer.from(candidate.password_hash || '', 'base64url');
  const passwordMatches = expected.length === calculated.length && timingSafeEqual(expected, calculated);
  return Boolean(account) && normalizeAdminEmail(email) === account.email && passwordMatches;
}

function sign(value, key) {
  return createHmac('sha256', key).update(value).digest('base64url');
}

export function createAdminSession(account, signingKey, now = Date.now()) {
  const csrfToken = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    email: account.email,
    version: account.version,
    issued_at: Math.floor(now / 1000),
    expires_at: Math.floor(now / 1000) + SESSION_SECONDS,
    csrf: csrfToken
  })).toString('base64url');
  return { token: `${payload}.${sign(payload, signingKey)}`, csrfToken, expiresIn: SESSION_SECONDS };
}

export function verifyAdminSession(token, account, signingKey, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra || !account || !signingKey) return null;
  const expected = sign(payload, signingKey);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.email !== account.email || session.version !== account.version || session.expires_at <= Math.floor(now / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  return Object.fromEntries(String(header || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function adminCookie(token, { secure = true, maxAge = SESSION_SECONDS } = {}) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearAdminCookie({ secure = true } = {}) {
  return `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function newSigningKey() {
  return randomBytes(32).toString('base64url');
}

export function safeAdminAccount(account) {
  return account ? { email: account.email, version: account.version, updated_at: account.updated_at } : null;
}
