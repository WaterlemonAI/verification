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
    this.formResults = new Map();
  }

  async save({ ownerId, reportId, bytes, metadata }) {
    const value = { bytes: Buffer.from(bytes), metadata: { ...metadata } };
    this.reports.set(`${partitionKey(ownerId)}:${reportId}`, value);
    this.publicReports.set(reportId, value);
    return metadata;
  }

  async get({ ownerId, reportId }) {
    const value = this.reports.get(`${partitionKey(ownerId)}:${reportId}`);
    return value ? { bytes: Buffer.from(value.bytes), metadata: { ...value.metadata } } : null;
  }

  async getPublic({ reportId }) {
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
}

export class AzureAdverseMediaReportStore {
  constructor({ blobServiceUrl, containerName = 'adverse-media-reports', tableServiceUrl, tableName = 'AdverseMediaReports', credential = new ContainerAppsManagedIdentityCredential() }) {
    const blobService = new BlobServiceClient(blobServiceUrl, credential);
    this.container = blobService.getContainerClient(containerName);
    this.table = new TableClient(tableServiceUrl || blobServiceUrl.replace('.blob.', '.table.'), tableName, credential);
  }

  async save({ ownerId, reportId, bytes, metadata }) {
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
      retention: 'permanent'
    };
    await this.table.upsertEntity(entity, 'Replace');
    await this.table.upsertEntity({ ...entity, partitionKey: 'public' }, 'Replace');
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
          select: ['blobName', 'transactionId', 'generatedAt', 'sha256', 'filename', 'reportType', 'retention']
        }
      });
      for await (const candidate of legacy) {
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
