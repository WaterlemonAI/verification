import { createHash } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createKeyCreationLock({ blobServiceUrl = process.env.ADVERSE_MEDIA_REPORT_BLOB_URL,
  containerName = process.env.ADVERSE_MEDIA_REPORT_CONTAINER || 'adverse-media-reports',
  credential = new ContainerAppsManagedIdentityCredential() } = {}) {
  if (!blobServiceUrl) return null;
  const container = new BlobServiceClient(blobServiceUrl, credential).getContainerClient(containerName);
  return async function withWorkspaceKeyLock(workspaceId, operation) {
    const workspace = createHash('sha256').update(workspaceId).digest('hex');
    const blob = container.getBlockBlobClient(`workspace-key-locks/${workspace}.lock`);
    try {
      await blob.uploadData(Buffer.alloc(0), { conditions: { ifNoneMatch: '*' } });
    } catch (error) {
      if (![409, 412].includes(error.statusCode)) throw error;
    }
    const lease = blob.getBlobLeaseClient();
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await lease.acquireLease(60);
        break;
      } catch (error) {
        if (![409, 412].includes(error.statusCode)) throw error;
        if (Date.now() >= deadline) throw new Error('workspace_key_lock_busy');
        await wait(100 + Math.floor(Math.random() * 150));
      }
    }
    let leaseValid = true;
    const renew = setInterval(() => {
      void lease.renewLease().catch(() => { leaseValid = false; });
    }, 20_000);
    renew.unref?.();
    try {
      return await operation(() => leaseValid);
    } finally {
      clearInterval(renew);
      await lease.releaseLease().catch(() => {});
    }
  };
}
