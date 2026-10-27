import { createHash, randomUUID } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { TableClient, odata } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { decryptDocumentOcr, encryptDocumentOcr } from './document-ocr-crypto.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const retentionMs = 30 * 24 * 60 * 60 * 1_000;
const jobRow = (id) => `job_${id}`;
const idemRow = (key) => `idem_${sha256(key)}`;
const PENDING_INDEX = 'ocr-index-pending';
const EXPIRY_INDEX = 'ocr-index-expiry';
const indexKey = (date, jobId) => `${date}_${jobId}`;
const indexCutoff = (date) => `${date.toISOString()}~`;
const missing = (error) => error?.statusCode === 404 || error?.code === 'ResourceNotFound';
const conflict = (error) => error?.statusCode === 409 || error?.code === 'EntityAlreadyExists';

async function download(blob) {
  const response = await blob.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function publicJob(row) {
  return {
    id: row.jobId, service_id: row.serviceId, transaction_id: row.transactionId,
    status: row.status, stage: row.stage, created_at: row.createdAt,
    completed_at: row.completedAt || null, expires_at: row.expiresAt,
    reason_code: row.reasonCode || null,
    provider_calls: { azure: Number(row.azureCallCount || 0), gemini: Number(row.geminiCallCount || 0) }
  };
}

export class AzureDocumentOcrStore {
  constructor({ accountUrl, containerName = 'document-ocr-private', queueName = 'document-ocr-jobs',
    tableName = 'DocumentOcrJobs', credential = new ContainerAppsManagedIdentityCredential(),
    container, queue, deadLetterQueue, table } = {}) {
    if (!accountUrl && !(container && queue && table)) throw new Error('document_ocr_storage_unavailable');
    this.container = container || new BlobServiceClient(accountUrl, credential).getContainerClient(containerName);
    this.queue = queue || new QueueClient(`${accountUrl.replace('.blob.', '.queue.').replace(/\/$/, '')}/${queueName}`, credential);
    this.deadLetterQueue = deadLetterQueue || (accountUrl ? new QueueClient(`${accountUrl.replace('.blob.', '.queue.').replace(/\/$/, '')}/document-ocr-dead-letter`, credential) : null);
    this.table = table || new TableClient(accountUrl.replace('.blob.', '.table.'), tableName, credential);
  }

  partition(ownerId) { return sha256(`workspace:${ownerId}`); }
  blob(partitionKey, id, name) { return this.container.getBlockBlobClient(`${partitionKey}/${id}/${name}`); }

  async enqueue(row) {
    await this.queue.sendMessage(Buffer.from(JSON.stringify({ version: 1, partitionKey: row.partitionKey,
      jobId: row.jobId })).toString('base64'), { messageTimeToLive: 7 * 24 * 60 * 60 });
    await this.table.updateEntity({ partitionKey: row.partitionKey, rowKey: row.rowKey, queueSent: true }, 'Merge');
  }

  async createJob({ ownerId, serviceId, files, idempotencyKey, transactionId, billingLogKey = '' }) {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new Error('document_ocr_idempotency_invalid');
    const partitionKey = this.partition(ownerId);
    const requestHash = sha256(JSON.stringify({ serviceId,
      files: files.map((file) => ({ sha256: sha256(file.bytes), mediaType: file.mediaType })) }));
    const key = idemRow(idempotencyKey);
    try {
      const prior = await this.table.getEntity(partitionKey, key);
      if (prior.requestHash !== requestHash) throw new Error('document_ocr_idempotency_conflict');
      const row = await this.table.getEntity(partitionKey, jobRow(prior.jobId));
      if (row.status === 'queued' && !row.queueSent) await this.enqueue(row);
      return { job: publicJob(row), reused: true };
    } catch (error) { if (!missing(error)) throw error; }

    const id = `ocr_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + retentionMs).toISOString();
    const pendingAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const pendingIndexKey = indexKey(pendingAt, id);
    const expiryIndexKey = indexKey(expiresAt, id);
    const row = { partitionKey, rowKey: jobRow(id), jobId: id, serviceId, transactionId,
      status: 'queued', stage: 'queued', queueSent: false, createdAt, expiresAt,
      idemRowKey: key, billingWorkspaceId: ownerId, billingLogKey,
      pendingIndexKey, expiryIndexKey,
      fileCount: files.length, processedFiles: 0, azureCallCount: 0, geminiCallCount: 0,
      fileTypesJson: JSON.stringify(files.map((file) => file.mediaType)) };
    for (const [index, file] of files.entries()) {
      await this.blob(partitionKey, id, `input-${index}.bin`).uploadData(encryptDocumentOcr(file.bytes), {
        blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
      });
    }
    try {
      await this.table.createEntity({ partitionKey: PENDING_INDEX, rowKey: pendingIndexKey, ownerPartition: partitionKey, jobId: id });
      await this.table.createEntity({ partitionKey: EXPIRY_INDEX, rowKey: expiryIndexKey, ownerPartition: partitionKey, jobId: id });
      await this.table.submitTransaction([
        ['create', { partitionKey, rowKey: key, jobId: id, requestHash, expiresAt }],
        ['create', row]
      ]);
    } catch (error) {
      try {
        const committed = await this.table.getEntity(partitionKey, jobRow(id));
        if (committed) {
          if (!committed.queueSent) await this.enqueue(committed);
          return { job: publicJob(committed), reused: false };
        }
      } catch (lookupError) { if (!missing(lookupError)) throw lookupError; }
      for (const [indexPartition, indexRowKey] of [[PENDING_INDEX, pendingIndexKey], [EXPIRY_INDEX, expiryIndexKey]]) {
        await this.table.deleteEntity(indexPartition, indexRowKey).catch((cleanupError) => {
          if (!missing(cleanupError)) throw cleanupError;
        });
      }
      for await (const blob of this.container.listBlobsFlat({ prefix: `${partitionKey}/${id}/` })) {
        await this.container.deleteBlob(blob.name);
      }
      if (!conflict(error)) throw error;
      const prior = await this.table.getEntity(partitionKey, key);
      if (prior.requestHash !== requestHash) throw new Error('document_ocr_idempotency_conflict');
      return { job: publicJob(await this.table.getEntity(partitionKey, jobRow(prior.jobId))), reused: true };
    }
    await this.enqueue(row);
    return { job: publicJob(row), reused: false };
  }

  async getRow(partitionKey, id) {
    if (!/^ocr_[0-9a-f-]{36}$/.test(id)) return null;
    try {
      const row = await this.table.getEntity(partitionKey, jobRow(id));
      return Date.parse(row.expiresAt) > Date.now() ? row : null;
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  async getJob(ownerId, id) {
    const row = await this.getRow(this.partition(ownerId), id);
    return row ? publicJob(row) : null;
  }

  async getResult(ownerId, id) {
    const partitionKey = this.partition(ownerId);
    const row = await this.getRow(partitionKey, id);
    if (!row) return null;
    const job = publicJob(row);
    if (row.status !== 'completed' && row.status !== 'review_required') return { job };
    const bytes = await download(this.blob(partitionKey, id, 'result.bin'));
    return { job, result: JSON.parse(decryptDocumentOcr(bytes).toString('utf8')) };
  }

  async getInputs(partitionKey, id) {
    const row = await this.getRow(partitionKey, id);
    if (!row) return null;
    const mediaTypes = JSON.parse(row.fileTypesJson);
    const files = await Promise.all(mediaTypes.map(async (mediaType, index) => ({ mediaType,
      bytes: decryptDocumentOcr(await download(this.blob(partitionKey, id, `input-${index}.bin`))) })));
    return { row, files };
  }

  async transition(row, stage, additional = {}) {
    const next = { partitionKey: row.partitionKey, rowKey: row.rowKey, stage, ...additional };
    await this.table.updateEntity(next, 'Merge', { etag: row.etag });
    return this.table.getEntity(row.partitionKey, row.rowKey);
  }

  async saveOcr(row, pages, providerCalls, processedFiles, figures = []) {
    const bundle = { pages, figures: figures.map((item) => ({ id: item.id, page: item.page,
      contentType: item.contentType, bytes: item.bytes.toString('base64') })) };
    await this.blob(row.partitionKey, row.jobId, 'ocr.bin').uploadData(encryptDocumentOcr(Buffer.from(JSON.stringify(bundle))), {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
    });
    return this.transition(row, processedFiles === row.fileCount ? 'ocr_complete' : 'ocr_partial',
      { azureCallCount: providerCalls, processedFiles });
  }

  async getOcr(row) {
    const bundle = JSON.parse(decryptDocumentOcr(await download(this.blob(row.partitionKey, row.jobId, 'ocr.bin'))).toString('utf8'));
    return { pages: bundle.pages, figures: bundle.figures.map((item) => ({ ...item, bytes: Buffer.from(item.bytes, 'base64') })) };
  }

  async complete(row, result) {
    await this.blob(row.partitionKey, row.jobId, 'result.bin').uploadData(encryptDocumentOcr(Buffer.from(JSON.stringify(result))), {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
    });
    const status = result.review_required ? 'review_required' : 'completed';
    return this.transition(row, 'finished', { status, completedAt: new Date().toISOString() });
  }

  async fail(row, stage, reasonCode) {
    return this.transition(row, stage, { status: 'failed', reasonCode, completedAt: new Date().toISOString() });
  }

  async deadLetter(row, reasonCode) {
    if (!this.deadLetterQueue) throw new Error('document_ocr_dead_letter_unavailable');
    await this.deadLetterQueue.sendMessage(Buffer.from(JSON.stringify({ version: 1, jobId: row.jobId,
      partitionKey: row.partitionKey, reasonCode })).toString('base64'), { messageTimeToLive: 30 * 24 * 60 * 60 });
    return this.fail(row, 'dead_lettered', reasonCode);
  }

  async saveArtifact(row, name, bytes) {
    if (!['photo', 'signature'].includes(name)) throw new Error('document_ocr_artifact_invalid');
    await this.blob(row.partitionKey, row.jobId, `${name}.bin`).uploadData(encryptDocumentOcr(bytes), {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
    });
  }

  async getArtifact(ownerId, id, name) {
    if (!['photo', 'signature'].includes(name)) return null;
    const partitionKey = this.partition(ownerId);
    const row = await this.getRow(partitionKey, id);
    if (!row || !['completed', 'review_required'].includes(row.status)) return null;
    try { return decryptDocumentOcr(await download(this.blob(partitionKey, id, `${name}.bin`))); }
    catch (error) { if (missing(error)) return null; throw error; }
  }

  async markBillingSettled(row) {
    await this.table.updateEntity({ partitionKey: row.partitionKey, rowKey: row.rowKey,
      billingSettledAt: new Date().toISOString() }, 'Merge');
    if (row.pendingIndexKey) await this.table.deleteEntity(PENDING_INDEX, row.pendingIndexKey).catch((error) => {
      if (!missing(error)) throw error;
    });
  }

  async reconcileUsage(usageStore) {
    let reconciled = 0;
    const due = this.table.listEntities({ queryOptions: {
      filter: odata`PartitionKey eq ${PENDING_INDEX} and RowKey le ${indexCutoff(new Date())}`
    } });
    for await (const index of due) {
      let row;
      try { row = await this.table.getEntity(index.ownerPartition, jobRow(index.jobId)); }
      catch (error) {
        if (!missing(error)) throw error;
        await this.table.deleteEntity(PENDING_INDEX, index.rowKey);
        continue;
      }
      if (row.billingSettledAt || !row.billingLogKey) {
        await this.table.deleteEntity(PENDING_INDEX, index.rowKey);
        continue;
      }
      if (!['completed', 'review_required', 'failed'].includes(row.status)) {
        try { row = await this.fail(row, 'timed_out', 'DOCUMENT_OCR_JOB_TIMEOUT'); }
        catch (error) { if (error.statusCode === 412) continue; throw error; }
      }
      await usageStore.settleAsyncResult(row.billingWorkspaceId, row.billingLogKey, {
        successful: row.status !== 'failed', reason: row.reasonCode || 'document_ocr_processing_failed'
      });
      await this.markBillingSettled(row);
      reconciled += 1;
    }
    return reconciled;
  }

  async purgeExpired(now = new Date(), usageStore = null) {
    let purged = 0;
    const expired = this.table.listEntities({ queryOptions: {
      filter: odata`PartitionKey eq ${EXPIRY_INDEX} and RowKey le ${indexCutoff(now)}`
    } });
    for await (const index of expired) {
      let row;
      try { row = await this.table.getEntity(index.ownerPartition, jobRow(index.jobId)); }
      catch (error) {
        if (!missing(error)) throw error;
        await this.table.deleteEntity(EXPIRY_INDEX, index.rowKey);
        continue;
      }
      if (Date.parse(row.expiresAt) > now.getTime()) continue;
      if (row.billingLogKey && !row.billingSettledAt) {
        if (!usageStore) throw new Error('document_ocr_expired_billing_unsettled');
        await usageStore.settleAsyncResult(row.billingWorkspaceId, row.billingLogKey, {
          successful: ['completed', 'review_required'].includes(row.status),
          reason: row.reasonCode || 'DOCUMENT_OCR_EXPIRED_UNPROCESSED'
        });
      }
      for await (const blob of this.container.listBlobsFlat({ prefix: `${row.partitionKey}/${row.jobId}/` })) {
        await this.container.deleteBlob(blob.name);
      }
      await this.table.deleteEntity(row.partitionKey, row.rowKey);
      if (row.idemRowKey) await this.table.deleteEntity(row.partitionKey, row.idemRowKey).catch((error) => {
        if (!missing(error)) throw error;
      });
      if (row.pendingIndexKey) await this.table.deleteEntity(PENDING_INDEX, row.pendingIndexKey).catch((error) => {
        if (!missing(error)) throw error;
      });
      await this.table.deleteEntity(EXPIRY_INDEX, index.rowKey);
      purged += 1;
    }
    return purged;
  }
}

export function createDocumentOcrStore() {
  const accountUrl = process.env.DOCUMENT_OCR_STORAGE_BLOB_URL;
  return accountUrl ? new AzureDocumentOcrStore({ accountUrl }) : null;
}
