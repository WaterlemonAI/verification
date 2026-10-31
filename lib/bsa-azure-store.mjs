import { createHash, randomUUID } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { decryptBsa, encryptBsa } from './bsa-crypto.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const ownerPartition = (ownerId) => digest(String(ownerId));
const jobRow = (id) => `job_${id}`;
const idemRow = (key) => `idem_${digest(key)}`;
const terminal = new Set(['completed', 'partial', 'failed']);

async function downloadBuffer(blob) {
  const response = await blob.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function notFound(error) {
  return error?.statusCode === 404 || error?.code === 'ResourceNotFound';
}

export class AzureBsaStore {
  constructor({ accountUrl, containerName = 'bank-statement-analysis', queueName = 'bank-statement-analysis',
    tableName = 'BankStatementAnalysis', credential = new ContainerAppsManagedIdentityCredential(), container, queue, table }) {
    this.container = container || new BlobServiceClient(accountUrl, credential).getContainerClient(containerName);
    this.queue = queue || new QueueClient(`${accountUrl.replace('.blob.', '.queue.').replace(/\/$/, '')}/${queueName}`, credential);
    this.table = table || new TableClient(accountUrl.replace('.blob.', '.table.'), tableName, credential);
  }

  async enqueue(partitionKey, id) {
    await this.queue.sendMessage(Buffer.from(JSON.stringify({ version: 1, analysisId: id, partitionKey })).toString('base64'), {
      messageTimeToLive: 7 * 24 * 60 * 60
    });
    await this.table.updateEntity({ partitionKey, rowKey: jobRow(id), queueSent: true }, 'Merge');
  }

  async createJob({ ownerId, idempotencyKey, files, fields }) {
    const partitionKey = ownerPartition(ownerId);
    const fileHashes = files.map(({ bytes, mediaType }) => ({ hash: digest(bytes), mediaType }));
    const requestFields = fields.callback
      ? { ...fields, callback: { url: fields.callback.url, apiRoot: fields.callback.apiRoot,
        ...(fields.callback.accessKey ? { accessKeyHash: digest(fields.callback.accessKey) } : {}) } }
      : fields;
    const requestHash = digest(JSON.stringify({ fileHashes, fields: requestFields }));
    const idempotencyRow = idemRow(idempotencyKey);
    try {
      const prior = await this.table.getEntity(partitionKey, idempotencyRow);
      if (prior.requestHash !== requestHash) throw new Error('idempotency_conflict');
      const jobEntity = await this.table.getEntity(partitionKey, jobRow(prior.analysisId));
      if (!jobEntity.queueSent && jobEntity.status === 'queued') await this.enqueue(partitionKey, prior.analysisId);
      return { job: await this.getJob(prior.analysisId, ownerId), reused: true };
    } catch (error) {
      if (!notFound(error)) throw error;
    }

    const id = `bsa_${randomUUID()}`;
    const prefix = `${partitionKey}/${id}`;
    const job = { id, ownerId, status: 'queued', receivedAt: new Date().toISOString(), fileHashes,
      schemaVersion: 'bsa-v1.0.0', encrypted: true, storage: 'azure-private',
      callback: fields.callback
        ? { requested: true, status: 'pending', deliveryId: fields.callback.deliveryId, attempts: 0 }
        : { requested: false, status: 'not_requested' } };
    try {
      for (const [index, item] of files.entries()) {
        await this.container.getBlockBlobClient(`${prefix}/input-${index}.bin`).uploadData(encryptBsa(item.bytes), {
          blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
        });
      }
      await this.container.getBlockBlobClient(`${prefix}/fields.bin`).uploadData(encryptBsa(Buffer.from(JSON.stringify(fields))), {
        blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
      });
      await this.container.getBlockBlobClient(`${prefix}/inputs.json`).uploadData(Buffer.from(JSON.stringify(
        files.map(({ mediaType }, index) => ({ index, mediaType })))), {
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' }
      });
      await this.table.submitTransaction([
        ['create', { partitionKey, rowKey: idempotencyRow, analysisId: id, requestHash }],
        ['create', { partitionKey, rowKey: jobRow(id), analysisId: id, status: 'queued', queueSent: false,
          receivedAt: job.receivedAt, jobJson: JSON.stringify(job), blobPrefix: prefix }]
      ]);
      await this.enqueue(partitionKey, id);
      return { job, reused: false };
    } catch (error) {
      if (error?.statusCode === 409 || error?.code === 'EntityAlreadyExists') {
        const prior = await this.table.getEntity(partitionKey, idempotencyRow);
        if (prior.requestHash !== requestHash) throw new Error('idempotency_conflict');
        return { job: await this.getJob(prior.analysisId, ownerId), reused: true };
      }
      throw error;
    }
  }

  async getJob(id, ownerId) {
    if (!/^bsa_[0-9a-f-]{36}$/.test(id)) return null;
    let entity;
    try { entity = await this.table.getEntity(ownerPartition(ownerId), jobRow(id)); }
    catch (error) { if (notFound(error)) return null; throw error; }
    const job = JSON.parse(entity.jobJson);
    return { ...job, status: entity.status, completedAt: entity.completedAt || job.completedAt || null,
      reasonCodes: entity.reasonCodesJson ? JSON.parse(entity.reasonCodesJson) : (job.reasonCodes || []) };
  }

  async getResult(id, ownerId) {
    const job = await this.getJob(id, ownerId);
    if (!job) return null;
    if (!terminal.has(job.status)) return { job };
    const partitionKey = ownerPartition(ownerId);
    try {
      const bytes = await downloadBuffer(this.container.getBlobClient(`${partitionKey}/${id}/result.bin`));
      return { job, result: JSON.parse(decryptBsa(bytes)) };
    } catch (error) {
      if (notFound(error)) return { job };
      throw error;
    }
  }

  async getArtifact(id, ownerId, filename) {
    if (!['ledger.json', 'transactions.parquet', 'audit.pdf', 'analysis.xlsx'].includes(filename)) return null;
    const record = await this.getResult(id, ownerId);
    if (!record?.result?.artifacts?.some((item) => item.filename === filename)) return null;
    try {
      const bytes = await downloadBuffer(this.container.getBlobClient(`${ownerPartition(ownerId)}/${id}/artifact.${filename}.bin`));
      return decryptBsa(bytes);
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }
}

export function createAzureBsaStore() {
  const accountUrl = process.env.BSA_STORAGE_BLOB_URL;
  if (!accountUrl) return null;
  return new AzureBsaStore({ accountUrl,
    containerName: process.env.BSA_STORAGE_CONTAINER || 'bank-statement-analysis',
    queueName: process.env.BSA_STORAGE_QUEUE || 'bank-statement-analysis',
    tableName: process.env.BSA_STORAGE_TABLE || 'BankStatementAnalysis' });
}
