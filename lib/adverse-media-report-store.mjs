import { createHash } from 'node:crypto';
import { TableClient, odata } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const STORAGE_SCOPE = 'https://storage.azure.com/.default';

export function reportOwnerId(apiKey) {
  const token = String(apiKey || '');
  const client = /^ai7_live_([a-f0-9]{16})_[A-Za-z0-9_-]+$/.exec(token);
  return client ? `client-${client[1]}` : createHash('sha256').update(token).digest('hex');
}

function partitionKey(ownerId) {
  return createHash('sha256').update(String(ownerId)).digest('hex');
}

export class MemoryAdverseMediaReportStore {
  constructor() {
    this.reports = new Map();
    this.publicReports = new Map();
    this.privateReportIds = new Set();
    this.formResults = new Map();
    this.deepResearchStates = new Map();
    this.deepResearchUsage = new Map();
    this.deepResearchComponents = new Map();
  }

  async save({ ownerId, reportId, bytes, metadata, publicReport = true }) {
    const value = { bytes: Buffer.from(bytes), metadata: { ...metadata } };
    this.reports.set(`${partitionKey(ownerId)}:${reportId}`, value);
    if (publicReport) { this.publicReports.set(reportId, value); this.privateReportIds.delete(reportId); }
    else { this.publicReports.delete(reportId); this.privateReportIds.add(reportId); }
    return metadata;
  }

  async get({ ownerId, reportId }) {
    const value = this.reports.get(`${partitionKey(ownerId)}:${reportId}`);
    return value ? { bytes: Buffer.from(value.bytes), metadata: { ...value.metadata } } : null;
  }

  async getPublic({ reportId }) {
    if (this.privateReportIds.has(reportId)) return null;
    const value = this.publicReports.get(reportId)
      || [...this.reports.values()].find((report) => report.metadata.report_id === reportId);
    return value ? { bytes: Buffer.from(value.bytes), metadata: { ...value.metadata } } : null;
  }

  async saveFormResult({ ownerId, submissionId, result }) {
    this.formResults.set(`${partitionKey(ownerId)}:${submissionId}`, JSON.parse(JSON.stringify(result)));
  }

  async getFormResult({ ownerId, submissionId }) {
    const result = this.formResults.get(`${partitionKey(ownerId)}:${submissionId}`);
    return result ? JSON.parse(JSON.stringify(result)) : null;
  }

  async deleteFormResult({ ownerId, submissionId }) {
    this.formResults.delete(`${partitionKey(ownerId)}:${submissionId}`);
  }

  deepResearchKey(ownerId, screeningId) { return `${partitionKey(ownerId)}:${screeningId}`; }

  async getDeepResearchState({ ownerId, screeningId }) {
    const state = this.deepResearchStates.get(this.deepResearchKey(ownerId, screeningId));
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  async saveDeepResearchState({ ownerId, screeningId, state }) {
    this.deepResearchStates.set(this.deepResearchKey(ownerId, screeningId), JSON.parse(JSON.stringify(state)));
  }

  async deleteDeepResearchState({ ownerId, screeningId }) {
    this.deepResearchStates.delete(this.deepResearchKey(ownerId, screeningId));
  }

  async reserveDeepResearchCost({ ownerId, screeningId, costMicroUsd, provider, maxMicroUsd }) {
    const key = this.deepResearchKey(ownerId, screeningId);
    const current = this.deepResearchUsage.get(key) || { reservedMicroUsd: 0, providerCalls: { brave: 0, gemini: 0 } };
    if (current.reservedMicroUsd + costMicroUsd > maxMicroUsd) throw new Error('screening_cost_limit');
    const next = { reservedMicroUsd: current.reservedMicroUsd + costMicroUsd,
      providerCalls: { ...current.providerCalls, [provider]: (current.providerCalls[provider] || 0) + 1 } };
    this.deepResearchUsage.set(key, next);
    return { ...next, providerCalls: { ...next.providerCalls } };
  }

  async getDeepResearchUsage({ ownerId, screeningId }) {
    const value = this.deepResearchUsage.get(this.deepResearchKey(ownerId, screeningId));
    return value ? JSON.parse(JSON.stringify(value)) : { reservedMicroUsd: 0, providerCalls: { brave: 0, gemini: 0 } };
  }

  deepResearchComponentKey(ownerId, screeningId, componentKey) {
    return `${this.deepResearchKey(ownerId, screeningId)}:${createHash('sha256').update(componentKey).digest('hex')}`;
  }

  async getDeepResearchComponent({ ownerId, screeningId, componentKey }) {
    const value = this.deepResearchComponents.get(this.deepResearchComponentKey(ownerId, screeningId, componentKey));
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  async saveDeepResearchComponent({ ownerId, screeningId, componentKey, value }) {
    const key = this.deepResearchComponentKey(ownerId, screeningId, componentKey);
    if (!this.deepResearchComponents.has(key)) this.deepResearchComponents.set(key, JSON.parse(JSON.stringify(value)));
  }

  async deleteDeepResearchComponents({ ownerId, screeningId }) {
    const prefix = `${this.deepResearchKey(ownerId, screeningId)}:`;
    for (const key of this.deepResearchComponents.keys()) if (key.startsWith(prefix)) this.deepResearchComponents.delete(key);
  }
}

export class AzureAdverseMediaReportStore {
  constructor({ blobServiceUrl, containerName = 'adverse-media-reports', tableServiceUrl, tableName = 'AdverseMediaReports', credential = new ContainerAppsManagedIdentityCredential() }) {
    const blobService = new BlobServiceClient(blobServiceUrl, credential);
    this.container = blobService.getContainerClient(containerName);
    this.table = new TableClient(tableServiceUrl || blobServiceUrl.replace('.blob.', '.table.'), tableName, credential);
  }

  async save({ ownerId, reportId, bytes, metadata, publicReport = true }) {
    const owner = partitionKey(ownerId);
    const blobName = `${owner}/${reportId}.pdf`;
    const blob = this.container.getBlockBlobClient(blobName);
    await blob.uploadData(Buffer.from(bytes), {
      blobHTTPHeaders: { blobContentType: 'application/pdf', blobCacheControl: 'private, no-store' },
      metadata: { reportid: reportId, owner }
    });
    const entity = {
      partitionKey: owner,
      rowKey: reportId,
      blobName,
      transactionId: metadata.transaction_id,
      generatedAt: metadata.generated_at,
      sha256: metadata.sha256,
      filename: metadata.filename,
      reportType: metadata.report_type,
      publicReport,
      retention: 'permanent'
    };
    await this.table.upsertEntity(entity, 'Replace');
    if (publicReport) await this.table.upsertEntity({ ...entity, partitionKey: 'public' }, 'Replace');
    return metadata;
  }

  async downloadEntity(entity, reportId) {
    const response = await this.container.getBlobClient(entity.blobName).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    return {
      bytes: Buffer.concat(chunks),
      metadata: {
        report_id: reportId,
        transaction_id: entity.transactionId,
        generated_at: entity.generatedAt,
        sha256: entity.sha256,
        filename: entity.filename,
        report_type: entity.reportType,
        retention: entity.retention || 'permanent'
      }
    };
  }

  async get({ ownerId, reportId }) {
    const owner = partitionKey(ownerId);
    let entity;
    try { entity = await this.table.getEntity(owner, reportId); } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
    return this.downloadEntity(entity, reportId);
  }

  async getPublic({ reportId }) {
    let entity;
    try {
      entity = await this.table.getEntity('public', reportId);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    if (!entity) {
      const legacy = this.table.listEntities({
        queryOptions: {
          filter: odata`RowKey eq ${reportId}`,
          select: ['blobName', 'transactionId', 'generatedAt', 'sha256', 'filename', 'reportType', 'retention', 'publicReport']
        }
      });
      for await (const candidate of legacy) {
        if (candidate.publicReport === false) continue;
        entity = candidate;
        break;
      }
    }
    return entity ? this.downloadEntity(entity, reportId) : null;
  }

  formResultBlob(ownerId, submissionId) {
    return this.container.getBlockBlobClient(`forms-pending/${partitionKey(ownerId)}/${submissionId}.json`);
  }

  async saveFormResult({ ownerId, submissionId, result }) {
    const payload = Buffer.from(JSON.stringify(result));
    await this.formResultBlob(ownerId, submissionId).uploadData(payload, {
      blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
      metadata: { submissionid: submissionId, purpose: 'forms-callback-retry' }
    });
  }

  async getFormResult({ ownerId, submissionId }) {
    const response = await this.formResultBlob(ownerId, submissionId).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async deleteFormResult({ ownerId, submissionId }) {
    await this.formResultBlob(ownerId, submissionId).deleteIfExists({ deleteSnapshots: 'include' });
  }

  deepResearchStateBlob(ownerId, screeningId) {
    return this.container.getBlockBlobClient(`deep-research-pending/${partitionKey(ownerId)}/${screeningId}.json`);
  }

  async getDeepResearchState({ ownerId, screeningId }) {
    let response;
    try { response = await this.deepResearchStateBlob(ownerId, screeningId).download(); }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async saveDeepResearchState({ ownerId, screeningId, state }) {
    await this.deepResearchStateBlob(ownerId, screeningId).uploadData(Buffer.from(JSON.stringify(state)), {
      blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
      metadata: { screeningid: screeningId, purpose: 'deep-research-callback-retry' }
    });
  }

  async deleteDeepResearchState({ ownerId, screeningId }) {
    await this.deepResearchStateBlob(ownerId, screeningId).deleteIfExists({ deleteSnapshots: 'include' });
  }

  async reserveDeepResearchCost({ ownerId, screeningId, costMicroUsd, provider, maxMicroUsd }) {
    const partition = partitionKey(ownerId);
    const rowKey = `deep-research-cost-${screeningId}`;
    for (let attempt = 0; attempt < 12; attempt++) {
      let row;
      try { row = await this.table.getEntity(partition, rowKey); }
      catch (error) { if (error.statusCode !== 404) throw error; }
      const current = Number(row?.reservedMicroUsd || 0);
      if (!Number.isSafeInteger(current) || current + costMicroUsd > maxMicroUsd) throw new Error('screening_cost_limit');
      const providerCalls = row ? JSON.parse(row.providerCallsJson) : { brave: 0, gemini: 0 };
      providerCalls[provider] = (providerCalls[provider] || 0) + 1;
      const next = { partitionKey: partition, rowKey, reservedMicroUsd: String(current + costMicroUsd),
        providerCallsJson: JSON.stringify(providerCalls), updatedAt: new Date().toISOString() };
      try {
        if (row) await this.table.updateEntity(next, 'Replace', { etag: row.etag });
        else await this.table.createEntity(next);
        return { reservedMicroUsd: current + costMicroUsd, providerCalls };
      } catch (error) {
        if (![409, 412].includes(error.statusCode) || attempt === 11) throw error;
      }
    }
  }

  async getDeepResearchUsage({ ownerId, screeningId }) {
    let row;
    try { row = await this.table.getEntity(partitionKey(ownerId), `deep-research-cost-${screeningId}`); }
    catch (error) { if (error.statusCode !== 404) throw error; }
    return row ? { reservedMicroUsd: Number(row.reservedMicroUsd), providerCalls: JSON.parse(row.providerCallsJson) }
      : { reservedMicroUsd: 0, providerCalls: { brave: 0, gemini: 0 } };
  }

  deepResearchComponentBlob(ownerId, screeningId, componentKey) {
    const hash = createHash('sha256').update(componentKey).digest('hex');
    return this.container.getBlockBlobClient(`deep-research-components/${partitionKey(ownerId)}/${screeningId}/${hash}.json`);
  }

  async getDeepResearchComponent({ ownerId, screeningId, componentKey }) {
    let response;
    try { response = await this.deepResearchComponentBlob(ownerId, screeningId, componentKey).download(); }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async saveDeepResearchComponent({ ownerId, screeningId, componentKey, value }) {
    try {
      await this.deepResearchComponentBlob(ownerId, screeningId, componentKey).uploadData(Buffer.from(JSON.stringify(value)), {
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
        metadata: { screeningid: screeningId, purpose: 'deep-research-component-retry' },
        conditions: { ifNoneMatch: '*' }
      });
    } catch (error) {
      if (![409, 412].includes(error.statusCode)) throw error;
    }
  }

  async deleteDeepResearchComponents({ ownerId, screeningId }) {
    const prefix = `deep-research-components/${partitionKey(ownerId)}/${screeningId}/`;
    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      await this.container.deleteBlob(blob.name, { deleteSnapshots: 'include' });
    }
  }
}

export function createAdverseMediaReportStore() {
  const blobServiceUrl = process.env.ADVERSE_MEDIA_REPORT_BLOB_URL;
  if (!blobServiceUrl) return new MemoryAdverseMediaReportStore();
  return new AzureAdverseMediaReportStore({
    blobServiceUrl,
    tableServiceUrl: process.env.ADVERSE_MEDIA_REPORT_TABLE_URL,
    containerName: process.env.ADVERSE_MEDIA_REPORT_CONTAINER || 'adverse-media-reports',
    tableName: process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports'
  });
}

export const adverseMediaReportStorageScope = STORAGE_SCOPE;
