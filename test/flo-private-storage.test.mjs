import test from 'node:test';
import assert from 'node:assert/strict';
import { missingPrivateStorageGroups, verifyPrivateStorage } from '../scripts/verify-flo-private-storage.mjs';

const storageId = '/subscriptions/sub/resourceGroups/rg-flo-staging/providers/Microsoft.Storage/storageAccounts/flostgstore';
const connection = (group, status = 'Approved') => ({ properties: {
  provisioningState: 'Succeeded', privateEndpoint: { id: `/subscriptions/sub/resourceGroups/rg-flo-staging/providers/Microsoft.Network/privateEndpoints/pe-${group}` },
  privateLinkServiceConnectionState: { status }
} });
const endpoint = (group, target = storageId, status = 'Approved') => ({
  id: `/subscriptions/sub/resourceGroups/rg-flo-staging/providers/Microsoft.Network/privateEndpoints/pe-${group}`,
  provisioningState: 'Succeeded', privateLinkServiceConnections: [{
    privateLinkServiceId: target, groupIds: [group], privateLinkServiceConnectionState: { status }
  }]
});

test('private storage gate requires approved Blob, Table and Queue groups for the same account', () => {
  const connections = ['blob', 'table', 'queue'].map((group) => connection(group));
  const endpoints = ['blob', 'table', 'queue'].map((group) => endpoint(group));
  assert.deepEqual(missingPrivateStorageGroups(storageId, connections, endpoints), []);
  const az = (args) => args[2] === 'list' ? connections : endpoints.find((value) => value.id === args[4]);
  assert.equal(verifyPrivateStorage(storageId, az), true);
  assert.deepEqual(missingPrivateStorageGroups(storageId, connections,
    endpoints.map((value) => ({ ...value, privateLinkServiceConnections: [{
      ...value.privateLinkServiceConnections[0], groupIds: ['blob']
    }] }))), ['table', 'queue']);
  assert.deepEqual(missingPrivateStorageGroups(storageId, connections, endpoints.slice(0, 2)), ['queue']);
});

test('private storage gate ignores denied, incomplete and wrong-account connections', () => {
  const connections = [connection('blob'), connection('table'), connection('queue')];
  const endpoints = [endpoint('blob'), endpoint('table'), endpoint('queue')];
  assert.deepEqual(missingPrivateStorageGroups(storageId,
    [connections[0], connection('table', 'Rejected'), connections[2]], endpoints), ['table']);
  assert.deepEqual(missingPrivateStorageGroups(storageId, connections,
    [endpoints[0], endpoints[1], endpoint('queue', storageId.replace('flostgstore', 'otherstgstore'))]), ['queue']);
  assert.deepEqual(missingPrivateStorageGroups(storageId, connections,
    [endpoints[0], endpoints[1], { ...endpoints[2], provisioningState: 'Updating' }]), ['queue']);
});
