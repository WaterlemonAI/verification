import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

export const LOGIN_OTP_SECONDS = 10 * 60;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const partition = 'login-otp-v1';
const rowKey = (kind, email) => createHash('sha256').update(`${kind}:${email}`).digest('hex');
const isConflict = (error) => [409, 412].includes(error?.statusCode);
const isMissing = (error) => error?.statusCode === 404;

export function newLoginOtp() {
  return { challengeId: randomBytes(24).toString('base64url'), code: String(randomInt(0, 100_000_000)).padStart(8, '0') };
}

export function loginOtpHash({ kind, email, challengeId, code, signingKey }) {
  return createHmac('sha256', signingKey).update(`${kind}:${email}:${challengeId}:${code}`).digest('hex');
}

function matches(expected, actual) {
  const left = Buffer.from(String(expected || ''), 'hex');
  const right = Buffer.from(String(actual || ''), 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

function current(row, { challengeId, version, now }) {
  return row && row.challengeId === challengeId && Number(row.accountVersion) === Number(version)
    && Number(row.expiresAt) > now && !row.consumedAt && Number(row.attempts || 0) < MAX_ATTEMPTS;
}

export class MemoryLoginOtpStore {
  constructor() { this.rows = new Map(); }

  async issue({ kind, email, challengeId, codeHash, version, now = Date.now() }) {
    const key = rowKey(kind, email);
    const previous = this.rows.get(key);
    if (previous && Number(previous.accountVersion) === Number(version) && !previous.consumedAt
      && Number(previous.nextIssueAt) > now) return { issued: false, retryAfter: Math.ceil((previous.nextIssueAt - now) / 1000) };
    this.rows.set(key, { challengeId, codeHash, accountVersion: version, attempts: 0,
      expiresAt: now + LOGIN_OTP_SECONDS * 1000, nextIssueAt: now + RESEND_SECONDS * 1000, consumedAt: '' });
    return { issued: true };
  }

  async consume({ kind, email, challengeId, codeHash, version, now = Date.now() }) {
    const row = this.rows.get(rowKey(kind, email));
    if (!current(row, { challengeId, version, now })) return false;
    if (!matches(row.codeHash, codeHash)) { row.attempts += 1; return false; }
    row.consumedAt = new Date(now).toISOString();
    return true;
  }

  async cancel({ kind, email, challengeId }) {
    const row = this.rows.get(rowKey(kind, email));
    if (row?.challengeId === challengeId) row.consumedAt = new Date().toISOString();
  }
}

export class AzureLoginOtpStore {
  constructor({ table }) { this.table = table; }

  async read(key) {
    try { return await this.table.getEntity(partition, key); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }

  async issue({ kind, email, challengeId, codeHash, version, now = Date.now() }) {
    const key = rowKey(kind, email);
    const previous = await this.read(key);
    if (previous && Number(previous.accountVersion) === Number(version) && !previous.consumedAt
      && Number(previous.nextIssueAt) > now) return { issued: false, retryAfter: Math.ceil((previous.nextIssueAt - now) / 1000) };
    const row = { partitionKey: partition, rowKey: key, challengeId, codeHash,
      accountVersion: version, attempts: 0, expiresAt: String(now + LOGIN_OTP_SECONDS * 1000),
      nextIssueAt: String(now + RESEND_SECONDS * 1000), consumedAt: '' };
    try {
      if (previous) await this.table.updateEntity(row, 'Replace', { etag: previous.etag });
      else await this.table.createEntity(row);
      return { issued: true };
    } catch (error) {
      if (isConflict(error)) return { issued: false, retryAfter: RESEND_SECONDS };
      throw error;
    }
  }

  async consume({ kind, email, challengeId, codeHash, version, now = Date.now() }) {
    const key = rowKey(kind, email);
    const row = await this.read(key);
    if (!current(row, { challengeId, version, now })) return false;
    const valid = matches(row.codeHash, codeHash);
    try {
      await this.table.updateEntity({ partitionKey: partition, rowKey: key,
        attempts: Number(row.attempts || 0) + (valid ? 0 : 1),
        ...(valid ? { consumedAt: new Date(now).toISOString() } : {}) }, 'Merge', { etag: row.etag });
      return valid;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  async cancel({ kind, email, challengeId }) {
    const key = rowKey(kind, email);
    const row = await this.read(key);
    if (row?.challengeId !== challengeId) return;
    try { await this.table.updateEntity({ partitionKey: partition, rowKey: key,
      consumedAt: new Date().toISOString() }, 'Merge', { etag: row.etag }); }
    catch (error) { if (!isConflict(error)) throw error; }
  }
}

export function createLoginOtpStore() {
  if (!process.env.KEY_VAULT_URI) return new MemoryLoginOtpStore();
  const tableUrl = process.env.ADVERSE_MEDIA_REPORT_TABLE_URL;
  if (!tableUrl) return null;
  return new AzureLoginOtpStore({ table: new TableClient(tableUrl,
    process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports', new ContainerAppsManagedIdentityCredential()) });
}
