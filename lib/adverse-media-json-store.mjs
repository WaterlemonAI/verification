import { createHash } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const CONTAINER = 'adverse-media-json';

function ownerPath(ownerId) {
  return createHash('sha256').update(String(ownerId)).digest('hex');
}

export class MemoryAdverseMediaJsonStore {
  constructor() { this.records = new Map(); this.ready = true; }

  async save({ ownerId, screeningId, transactionId, input, response }) {
    const key = `${ownerPath(ownerId)}/${screeningId}`;
    const record = {
      version: 1,
      transaction_id: transactionId || null,
      screening_id: screeningId,
      stored_at: new Date().toISOString(),
      input,
      response
    };
    this.records.set(key, structuredClone(record));
    return record;
  }

  async get({ ownerId, screeningId }) {
    const value = this.records.get(`${ownerPath(ownerId)}/${screeningId}`);
    return value ? structuredClone(value) : null;
  }
}

export class AzureAdverseMediaJsonStore {
  constructor({ blobServiceUrl, credential = new ContainerAppsManagedIdentityCredential() }) {
    this.container = new BlobServiceClient(blobServiceUrl, credential).getContainerClient(CONTAINER);
    this.ready = true;
  }

  async save({ ownerId, screeningId, transactionId, input, response }) {
    const record = {
      version: 1,
      transaction_id: transactionId || null,
      screening_id: screeningId,
      stored_at: new Date().toISOString(),
      input,
      response
    };
    const blob = this.container.getBlockBlobClient(`${ownerPath(ownerId)}/${screeningId}.json`);
    await blob.uploadData(Buffer.from(JSON.stringify(record)), {
      blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
      metadata: { screeningid: screeningId, purpose: 'adverse-media-request-response' }
    });
    return record;
  }
}

export function createAdverseMediaJsonStore() {
  const blobServiceUrl = process.env.ADVERSE_MEDIA_JSON_BLOB_URL;
  if (blobServiceUrl) return new AzureAdverseMediaJsonStore({ blobServiceUrl });
  if (process.env.NODE_ENV === 'production') return {
    ready: false,
    save: async () => { throw new Error('adverse_json_storage_unconfigured'); }
  };
  return new MemoryAdverseMediaJsonStore();
}
