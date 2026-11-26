import { createHash } from 'node:crypto';
import { TableClient, odata } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const keyFor = (workspaceId, idempotencyKey, namespace = 'advance') => ({ partitionKey: `${namespace}-${hash(workspaceId).slice(0, 40)}`,
  rowKey: hash(idempotencyKey) });
const saved = (row, payloadHash) => row.payloadHash !== payloadHash
  ? { status: 'conflict', row } : { status: row.state === 'accepted' ? 'replayed' : 'in_progress', row };

export class MemoryAdvanceAdmissionStore {
  constructor({ namespace = 'advance' } = {}) { this.rows = new Map(); this.namespace = namespace; }
  async find({ workspaceId, screeningId }) {
    const partition = keyFor(workspaceId, '', this.namespace).partitionKey;
    return [...this.rows.values()].find((row) => row.partitionKey === partition
      && row.screeningId === screeningId) || null;
  }
  async claim({ workspaceId, idempotencyKey, payloadHash, job }) {
    const key = keyFor(workspaceId, idempotencyKey, this.namespace);
    const id = `${key.partitionKey}:${key.rowKey}`;
    const prior = this.rows.get(id);
    if (prior) return saved(prior, payloadHash);
    const row = { ...key, payloadHash, state: 'claimed', screeningId: job.screening_id,
      reportId: job.report_id, createdAt: new Date().toISOString() };
    this.rows.set(id, row);
    return { status: 'new', row };
  }
  async accept(row) {
    const id = `${row.partitionKey}:${row.rowKey}`;
    const prior = this.rows.get(id);
    if (!prior || prior.state !== 'claimed') throw new Error('advance_admission_invalid_state');
    this.rows.set(id, { ...prior, state: 'accepted' });
  }
  async abandon(row) {
    const id = `${row.partitionKey}:${row.rowKey}`;
    if (this.rows.get(id)?.state === 'claimed') this.rows.delete(id);
  }
}

export class AzureAdvanceAdmissionStore {
  constructor({ tableUrl, tableName = 'AdverseMediaReports', credential = new ContainerAppsManagedIdentityCredential(),
    tableClient = null, namespace = 'advance' }) {
    this.table = tableClient || new TableClient(tableUrl, tableName, credential);
    this.namespace = namespace;
  }
  async claim({ workspaceId, idempotencyKey, payloadHash, job }) {
    const key = keyFor(workspaceId, idempotencyKey, this.namespace);
    const row = { ...key, payloadHash, state: 'claimed', screeningId: job.screening_id,
      reportId: job.report_id, createdAt: new Date().toISOString() };
    try { await this.table.createEntity(row); return { status: 'new', row }; }
    catch (error) {
      if (error.statusCode !== 409) throw error;
      return saved(await this.table.getEntity(key.partitionKey, key.rowKey), payloadHash);
    }
  }
  async find({ workspaceId, screeningId }) {
    const partition = keyFor(workspaceId, '', this.namespace).partitionKey;
    const rows = this.table.listEntities({ queryOptions: {
      filter: odata`PartitionKey eq ${partition} and screeningId eq ${screeningId}`
    } });
    for await (const row of rows) return row;
    return null;
  }
  async accept(row) {
    const prior = await this.table.getEntity(row.partitionKey, row.rowKey);
    if (prior.state === 'accepted') return;
    if (prior.state !== 'claimed') throw new Error('advance_admission_invalid_state');
    await this.table.updateEntity({ partitionKey: row.partitionKey, rowKey: row.rowKey, state: 'accepted' },
      'Merge', { etag: prior.etag });
  }
  async abandon(row) {
    try {
      const prior = await this.table.getEntity(row.partitionKey, row.rowKey);
      if (prior.state === 'claimed') await this.table.deleteEntity(row.partitionKey, row.rowKey, { etag: prior.etag });
    } catch (error) { if (error.statusCode !== 404) throw error; }
  }
}

export function createAdvanceAdmissionStore() {
  const tableUrl = process.env.ADVERSE_MEDIA_REPORT_TABLE_URL;
  if (tableUrl) return new AzureAdvanceAdmissionStore({ tableUrl,
    tableName: process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports' });
  if (process.env.NODE_ENV === 'production') return null;
  return new MemoryAdvanceAdmissionStore();
}

export function createIncidentAdmissionStore() {
  const namespace = 'incident';
  const tableUrl = process.env.ADVERSE_MEDIA_REPORT_TABLE_URL;
  if (tableUrl) return new AzureAdvanceAdmissionStore({ tableUrl,
    tableName: process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports', namespace });
  if (process.env.NODE_ENV === 'production') return null;
  return new MemoryAdvanceAdmissionStore({ namespace });
}
