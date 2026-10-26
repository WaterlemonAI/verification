import * as local from './bsa-local-store.mjs';
import { createAzureBsaStore } from './bsa-azure-store.mjs';

let azure;
function activeAzure() {
  if (!process.env.BSA_PRODUCTION_ENABLED || process.env.BSA_PRODUCTION_ENABLED !== '1') return null;
  azure ||= createAzureBsaStore();
  return azure;
}

export function bsaEnabled() {
  return Boolean(activeAzure()) || local.bsaLocalEnabled();
}

export function bsaMode() {
  return activeAzure() ? 'azure' : local.bsaLocalEnabled() ? 'local' : 'disabled';
}

export function bsaCapabilities() {
  if (activeAzure()) return { enabled: true, mode: 'azure', engines: {
    native: 'ready', rapidocr: 'ready', paddleocr: 'ready', azureLayout: 'configured'
  } };
  return null;
}

export async function createBsaJob(args) {
  const store = activeAzure();
  return store ? store.createJob(args) : local.createBsaJob(args);
}

export async function getBsaJob(id, ownerId) {
  const store = activeAzure();
  return store ? store.getJob(id, ownerId) : local.getBsaJob(id, ownerId);
}

export async function getBsaResult(id, ownerId) {
  const store = activeAzure();
  return store ? store.getResult(id, ownerId) : local.getBsaResult(id, ownerId);
}

export async function getBsaArtifact(id, ownerId, filename) {
  const store = activeAzure();
  return store ? store.getArtifact(id, ownerId, filename) : local.getBsaArtifact(id, ownerId, filename);
}
