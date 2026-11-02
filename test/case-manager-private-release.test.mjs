import test from 'node:test';
import assert from 'node:assert/strict';
import { addressInCidr } from '../scripts/probe-case-manager-private-path.mjs';
import { verifyPrivateReleaseSnapshot } from '../scripts/verify-case-manager-private-release.mjs';

const environmentId = '/subscriptions/test/resourceGroups/kycprobe/providers/Microsoft.App/managedEnvironments/private';
const subnetId = '/subscriptions/test/resourceGroups/kycprobe/providers/Microsoft.Network/virtualNetworks/isolated/subnets/endpoints';
const identityId = '/subscriptions/test/resourceGroups/kycprobe/providers/Microsoft.ManagedIdentity/userAssignedIdentities/api';
const at = new Date('2026-10-30T12:00:00.000Z');

function snapshot() {
  return {
    expectedEnvironmentId: environmentId, expectedEndpointSubnetId: subnetId,
    runtimeIdentityResourceId: identityId, at,
    environment: { id: environmentId, vnetSubnet: 'dedicated-infrastructure-subnet' },
    storage: { location: 'uaenorth', publicNetworkAccess: 'Disabled',
      allowSharedKeyAccess: false, allowBlobPublicAccess: false },
    endpoints: Object.fromEntries(['blob', 'table', 'queue'].map((group) => [group,
      { provisioningState: 'Succeeded', subnetId, groupIds: [group], connectionStatuses: ['Approved'] }])),
    probeJob: { environmentId, userAssignedIdentities: { [identityId]: {} },
      image: `registry.example/api@sha256:${'a'.repeat(64)}`,
      command: ['node', 'scripts/probe-case-manager-private-path.mjs'] },
    executions: [{ status: 'Succeeded', startTime: '2026-10-30T11:59:00.000Z',
      endTime: '2026-10-30T11:59:30.000Z' }]
  };
}

test('private-path proof requires a recent successful container data-plane run', () => {
  assert.deepEqual(verifyPrivateReleaseSnapshot(snapshot()), { verified: true, probe_age_seconds: 30 });
  const publicStorage = snapshot();
  publicStorage.storage.publicNetworkAccess = 'Enabled';
  assert.throws(() => verifyPrivateReleaseSnapshot(publicStorage), /storage_unready/);
  const missingQueue = snapshot();
  missingQueue.endpoints.queue.connectionStatuses = ['Pending'];
  assert.throws(() => verifyPrivateReleaseSnapshot(missingQueue), /queue_unready/);
  const stale = snapshot();
  stale.executions[0].endTime = '2026-10-29T11:59:30.000Z';
  assert.throws(() => verifyPrivateReleaseSnapshot(stale), /probe_stale/);
  const failedLatest = snapshot();
  failedLatest.executions.push({ status: 'Failed', startTime: '2026-10-30T12:00:00.000Z',
    endTime: '2026-10-30T12:00:01.000Z' });
  assert.throws(() => verifyPrivateReleaseSnapshot(failedLatest), /probe_stale/);
});

test('probe accepts only addresses in the dedicated private-endpoint subnet', () => {
  assert.equal(addressInCidr('10.244.2.7', '10.244.2.0/27'), true);
  assert.equal(addressInCidr('10.244.2.33', '10.244.2.0/27'), false);
  assert.equal(addressInCidr('4.161.95.5', '10.244.2.0/27'), false);
  assert.equal(addressInCidr('2001:db8::1', '10.244.2.0/27'), false);
});
