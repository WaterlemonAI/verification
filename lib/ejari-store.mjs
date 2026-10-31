import { createHash, randomUUID } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { TableClient } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { decryptEjari, encryptEjari } from './ejari-crypto.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const partitionFor = (workspaceId) => digest(`ejari:${workspaceId}`);
const terminal = new Set(['verified', 'review_required', 'not_found', 'could_not_complete']);
const notFound = (error) => error?.statusCode === 404 || error?.code === 'ResourceNotFound';

async function downloadBuffer(blob) {
  const response = await blob.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export class AzureEjariStore {
  constructor({ accountUrl, credential = new ContainerAppsManagedIdentityCredential(), container, queue, table, expiryTable }) {
    this.container = container || new BlobServiceClient(accountUrl, credential).getContainerClient('ejari-private');
    this.queue = queue || new QueueClient(`${accountUrl.replace('.blob.', '.queue.').replace(/\/$/, '')}/ejari-jobs`, credential);
    this.table = table || new TableClient(accountUrl.replace('.blob.', '.table.'), 'EjariJobs', credential);
    this.expiryTable = expiryTable || new TableClient(accountUrl.replace('.blob.', '.table.'), 'EjariExpiry', credential);
  }

  async enqueue(partitionKey, id) {
    await this.queue.sendMessage(Buffer.from(JSON.stringify({ version: 1, partitionKey, jobId: id })).toString('base64'), {
      messageTimeToLive: 7 * 24 * 60 * 60
    });
    await this.table.updateEntity({ partitionKey, rowKey: `job_${id}`, queueSent: true }, 'Merge');
  }

  async ensureExpiry(row, idemKey) {
    await this.expiryTable.upsertEntity({ partitionKey: row.expiresAt.slice(0, 7).replace('-', ''),
      rowKey: `${row.expiresAt.replace(/\D/g, '')}_${row.jobId}`, jobId: row.jobId,
      jobPartition: row.partitionKey, idemKey,
      blobPrefix: row.blobPrefix, expiresAt: row.expiresAt }, 'Merge');
  }

  async createJob({ workspaceId, idempotencyKey, fields, pdfBytes = null }) {
    const partitionKey = partitionFor(workspaceId);
    const requestHash = digest(JSON.stringify({ fields, pdfHash: pdfBytes ? digest(pdfBytes) : null }));
    const idemKey = `idem_${digest(idempotencyKey)}`;
    try {
      const prior = await this.table.getEntity(partitionKey, idemKey);
      if (prior.requestHash !== requestHash) throw new Error('idempotency_conflict');
      const row = await this.table.getEntity(partitionKey, `job_${prior.jobId}`);
      if (Date.parse(row.expiresAt) <= Date.now()) throw new Error('idempotency_expired');
      await this.ensureExpiry(row, idemKey);
      if (!row.queueSent && row.status === 'queued') await this.enqueue(partitionKey, prior.jobId);
      return { job: await this.getJob(prior.jobId, workspaceId), reused: true };
    } catch (error) { if (!notFound(error)) throw error; }

    const id = `ejari_${randomUUID()}`;
    const prefix = `${partitionKey}/${id}`;
    const receivedAt = new Date().toISOString();
    const job = { id, status: 'queued', receivedAt, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
    await this.container.getBlockBlobClient(`${prefix}/request.bin`).uploadData(encryptEjari(Buffer.from(JSON.stringify(fields))), {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
    });
    if (pdfBytes) await this.container.getBlockBlobClient(`${prefix}/input.pdf.bin`).uploadData(encryptEjari(pdfBytes), {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
    });
    try {
      await this.table.submitTransaction([
        ['create', { partitionKey, rowKey: idemKey, jobId: id, requestHash, expiresAt: job.expiresAt }],
        ['create', { partitionKey, rowKey: `job_${id}`, jobId: id, status: 'queued', queueSent: false,
          receivedAt, expiresAt: job.expiresAt, blobPrefix: prefix }]
      ]);
    } catch (error) {
      if (error?.statusCode !== 409 && error?.code !== 'EntityAlreadyExists') throw error;
      const prior = await this.table.getEntity(partitionKey, idemKey);
      if (prior.requestHash !== requestHash) throw new Error('idempotency_conflict');
      const row = await this.table.getEntity(partitionKey, `job_${prior.jobId}`);
      if (Date.parse(row.expiresAt) <= Date.now()) throw new Error('idempotency_expired');
      await this.ensureExpiry(row, idemKey);
      if (!row.queueSent && row.status === 'queued') await this.enqueue(partitionKey, prior.jobId);
      return { job: await this.getJob(prior.jobId, workspaceId), reused: true };
    }
    await this.ensureExpiry({ ...job, partitionKey, jobId: id, blobPrefix: prefix }, idemKey);
    await this.enqueue(partitionKey, id);
    return { job, reused: false };
  }

  async getJob(id, workspaceId) {
    if (!/^ejari_[0-9a-f-]{36}$/.test(id)) return null;
    try {
      const row = await this.table.getEntity(partitionFor(workspaceId), `job_${id}`);
      if (Date.parse(row.expiresAt) <= Date.now()) return null;
      return { id, status: row.status, receivedAt: row.receivedAt, completedAt: row.completedAt || null,
        expiresAt: row.expiresAt, reasonCode: row.reasonCode || null };
    } catch (error) { if (notFound(error)) return null; throw error; }
  }

  async getResult(id, workspaceId) {
    const job = await this.getJob(id, workspaceId);
    if (!job) return null;
    if (!terminal.has(job.status)) return { job };
    const prefix = `${partitionFor(workspaceId)}/${id}`;
    try {
      const result = JSON.parse(decryptEjari(await downloadBuffer(this.container.getBlobClient(`${prefix}/result.bin`))));
      return { job, result };
    } catch (error) { if (notFound(error)) return { job }; throw error; }
  }

  async getCertificate(id, workspaceId) {
    const record = await this.getResult(id, workspaceId);
    if (!record?.result?.certificateAvailable) return null;
    const prefix = `${partitionFor(workspaceId)}/${id}`;
    try { return decryptEjari(await downloadBuffer(this.container.getBlobClient(`${prefix}/certificate.pdf.bin`))); }
    catch (error) { if (notFound(error)) return null; throw error; }
  }
}

export function createEjariStore() {
  const accountUrl = process.env.EJARI_STORAGE_BLOB_URL;
  return accountUrl ? new AzureEjariStore({ accountUrl }) : null;
}
