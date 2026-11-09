import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const requiredGroups = ['blob', 'table', 'queue'];
const normalized = (value) => String(value || '').toLowerCase();

export function missingPrivateStorageGroups(storageId, storageConnections, privateEndpoints) {
  const approvedEndpoints = new Set(storageConnections
    .filter((connection) => connection.properties?.privateLinkServiceConnectionState?.status === 'Approved'
      && connection.properties?.provisioningState === 'Succeeded')
    .map((connection) => normalized(connection.properties?.privateEndpoint?.id))
    .filter(Boolean));
  const covered = new Set();
  for (const endpoint of privateEndpoints) {
    if (!approvedEndpoints.has(normalized(endpoint.id)) || endpoint.provisioningState !== 'Succeeded') continue;
    for (const connection of [
      ...(endpoint.privateLinkServiceConnections || []),
      ...(endpoint.manualPrivateLinkServiceConnections || [])
    ]) {
      if (normalized(connection.privateLinkServiceId) !== normalized(storageId)
        || connection.privateLinkServiceConnectionState?.status !== 'Approved') continue;
      for (const group of connection.groupIds || []) covered.add(group);
    }
  }
  return requiredGroups.filter((group) => !covered.has(group));
}

export function verifyPrivateStorage(storageId, az = (args) => JSON.parse(execFileSync('az', args,
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))) {
  if (!/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/Microsoft\.Storage\/storageAccounts\/[^/]+$/i.test(storageId))
    throw new Error('flo_private_storage_invalid_id');
  const storageConnections = az(['network', 'private-endpoint-connection', 'list', '--id', storageId, '--output', 'json']);
  if (!Array.isArray(storageConnections)) throw new Error('flo_private_storage_connections_unavailable');
  const endpointIds = [...new Set(storageConnections.filter((connection) =>
    connection.properties?.privateLinkServiceConnectionState?.status === 'Approved'
    && connection.properties?.provisioningState === 'Succeeded')
    .map((connection) => connection.properties?.privateEndpoint?.id).filter(Boolean))];
  const endpoints = endpointIds.map((id) => az(['network', 'private-endpoint', 'show', '--ids', id, '--output', 'json']));
  const missing = missingPrivateStorageGroups(storageId, storageConnections, endpoints);
  if (missing.length) throw new Error(`flo_private_storage_missing_${missing.join('_')}`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPrivateStorage(process.argv[2] || '');
  process.stdout.write('Approved Blob, Table and Queue private endpoints verified.\n');
}
