import { createHash } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export function formSubmissionFingerprint(form, submission) {
  return digest(JSON.stringify({ form_id: form.id, form_version: form.version,
    data: submission.data, callback_url: submission.callback_url,
    ...(submission.callback_access_key ? { callback_access_key_hash: digest(submission.callback_access_key) } : {}),
    customer_logo_url: submission.customer_logo_url || '' }));
}

function identity(workspaceId, formId, idempotencyKey) {
  return { partitionKey: `forms-${digest(workspaceId).slice(0, 40)}`,
    rowKey: digest(`${formId}:${idempotencyKey}`) };
}

function claimRow(identityKey, payloadHash, form, job) {
  return { ...identityKey, payloadHash, state: 'claimed',
    submissionId: job.submission_id, deliveryId: job.delivery_id,
    formId: form.id, formName: form.name, formVersion: Number(form.version || 1),
    createdAt: now(), updatedAt: now() };
}

function existingClaim(row, payloadHash) {
  if (row.payloadHash !== payloadHash) return { status: 'conflict', row };
  return { status: row.state === 'accepted' ? 'replayed' : 'in_progress', row };
}

export function publicFormQueueReceipt(row, { initialSecret = '' } = {}) {
  return {
    submission_id: row.submissionId,
    status: 'queued',
    form: { id: row.formId, name: row.formName, version: row.formVersion },
    callback: {
      configured: true,
      event: 'forms.submission.completed',
      signature_header: 'x-ai7-signature',
      delivery_id_header: 'x-ai7-delivery-id',
      ...(initialSecret ? { signing_secret: initialSecret } : {})
    },
    message: initialSecret
      ? 'The consolidated response and permanent PDF link will be posted to the callback URL. Store the signing secret now; it is not shown again.'
      : 'This submission was already accepted. Its original callback signing secret is not shown again.'
  };
}

export class MemoryFormsSubmissionStore {
  constructor() { this.rows = new Map(); }

  async claim({ workspaceId, form, idempotencyKey, payloadHash, job }) {
    const key = identity(workspaceId, form.id, idempotencyKey);
    const name = `${key.partitionKey}:${key.rowKey}`;
    const existing = this.rows.get(name);
    if (existing) return existingClaim(existing, payloadHash);
    const row = claimRow(key, payloadHash, form, job);
    this.rows.set(name, row);
    return { status: 'new', row };
  }

  async accept(row) {
    const key = `${row.partitionKey}:${row.rowKey}`;
    const existing = this.rows.get(key);
    if (!existing) throw new Error('form_claim_missing');
    this.rows.set(key, { ...existing, state: 'accepted', updatedAt: now() });
  }

  async abandon(row) {
    const key = `${row.partitionKey}:${row.rowKey}`;
    if (this.rows.get(key)?.state === 'claimed') this.rows.delete(key);
  }
}

export class AzureFormsSubmissionStore {
  constructor({ tableUrl, tableName = 'AdverseMediaReports', credential = new ContainerAppsManagedIdentityCredential(), tableClient = null }) {
    this.table = tableClient || new TableClient(tableUrl, tableName, credential);
  }

  async claim({ workspaceId, form, idempotencyKey, payloadHash, job }) {
    const key = identity(workspaceId, form.id, idempotencyKey);
    const row = claimRow(key, payloadHash, form, job);
    try {
      await this.table.createEntity(row);
      return { status: 'new', row };
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      return existingClaim(await this.table.getEntity(key.partitionKey, key.rowKey), payloadHash);
    }
  }

  async accept(row) {
    const existing = await this.table.getEntity(row.partitionKey, row.rowKey);
    if (existing.state === 'accepted') return;
    if (existing.state !== 'claimed') throw new Error('form_claim_invalid_state');
    await this.table.updateEntity({ partitionKey: row.partitionKey, rowKey: row.rowKey,
      state: 'accepted', updatedAt: now() }, 'Merge', { etag: existing.etag });
  }

  async abandon(row) {
    try {
      const existing = await this.table.getEntity(row.partitionKey, row.rowKey);
      if (existing.state === 'claimed') await this.table.deleteEntity(row.partitionKey, row.rowKey, { etag: existing.etag });
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }
}

export function createFormsSubmissionStore() {
  const tableUrl = process.env.ADVERSE_MEDIA_REPORT_TABLE_URL;
  return tableUrl ? new AzureFormsSubmissionStore({ tableUrl, tableName: process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports' })
    : new MemoryFormsSubmissionStore();
}
