import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GROUPS = ['blob', 'table', 'queue'];

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

export function verifyPrivateReleaseSnapshot({ environment, storage, endpoints, probeJob, executions,
  expectedEnvironmentId, expectedEndpointSubnetId, runtimeIdentityResourceId, at = new Date() }) {
  requireValue(expectedEnvironmentId && expectedEndpointSubnetId && runtimeIdentityResourceId,
    'case_manager_private_configuration_missing');
  requireValue(environment?.id?.toLowerCase() === expectedEnvironmentId.toLowerCase()
    && Boolean(environment?.vnetSubnet), 'case_manager_private_environment_missing');
  requireValue(storage?.location?.toLowerCase() === 'uaenorth'
    && storage?.publicNetworkAccess === 'Disabled'
    && storage?.allowSharedKeyAccess === false
    && storage?.allowBlobPublicAccess === false, 'case_manager_private_storage_unready');
  for (const group of GROUPS) {
    const endpoint = endpoints?.[group];
    requireValue(endpoint?.provisioningState === 'Succeeded'
      && endpoint?.subnetId?.toLowerCase() === expectedEndpointSubnetId.toLowerCase()
      && endpoint?.groupIds?.includes(group)
      && endpoint?.connectionStatuses?.includes('Approved'), `case_manager_private_${group}_unready`);
  }
  const identities = Object.keys(probeJob?.userAssignedIdentities || {}).map((id) => id.toLowerCase());
  requireValue(probeJob?.environmentId?.toLowerCase() === expectedEnvironmentId.toLowerCase()
    && identities.includes(runtimeIdentityResourceId.toLowerCase())
    && /^.+@sha256:[a-f0-9]{64}$/.test(probeJob?.image || '')
    && probeJob?.command?.join(' ') === 'node scripts/probe-case-manager-private-path.mjs',
  'case_manager_private_probe_unready');
  const latest = [...(executions || [])].sort((a, b) => Date.parse(b.startTime || '') - Date.parse(a.startTime || ''))[0];
  const ageMs = new Date(at).getTime() - Date.parse(latest?.endTime || '');
  requireValue(latest?.status === 'Succeeded' && Number.isFinite(ageMs)
    && ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000, 'case_manager_private_probe_stale');
  return { verified: true, probe_age_seconds: Math.floor(ageMs / 1000) };
}

export function verifyPrivateReleaseFromAzure({ resourceGroup, environmentId, endpointSubnetId,
  runtimeIdentityResourceId, storageName = 'stai7uaecasesuaen001',
  probeJobName = 'caj-ai7uae-cm-private-probe', runAz = (args) =>
    JSON.parse(execFileSync('az', [...args, '-o', 'json'], { encoding: 'utf8' })) } = {}) {
  if (!resourceGroup || !environmentId || !endpointSubnetId || !runtimeIdentityResourceId) {
    throw new Error('case_manager_private_configuration_missing');
  }
  const environment = runAz(['containerapp', 'env', 'show', '--ids', environmentId,
    '--query', '{id:id,vnetSubnet:properties.vnetConfiguration.infrastructureSubnetId}']);
  const storage = runAz(['storage', 'account', 'show', '-g', resourceGroup, '-n', storageName,
    '--query', '{location:location,publicNetworkAccess:publicNetworkAccess,allowSharedKeyAccess:allowSharedKeyAccess,allowBlobPublicAccess:allowBlobPublicAccess}']);
  const endpoints = Object.fromEntries(GROUPS.map((group) => {
    const endpoint = runAz(['network', 'private-endpoint', 'show', '-g', resourceGroup,
      '-n', `pe-ai7uae-cases-${group}-uaen-001`, '--query',
      '{provisioningState:provisioningState,subnetId:subnet.id,groupIds:privateLinkServiceConnections[0].groupIds,connectionStatuses:privateLinkServiceConnections[].privateLinkServiceConnectionState.status}']);
    return [group, endpoint];
  }));
  const probeJob = runAz(['containerapp', 'job', 'show', '-g', resourceGroup, '-n', probeJobName,
    '--query', '{environmentId:properties.environmentId,userAssignedIdentities:identity.userAssignedIdentities,image:properties.template.containers[0].image,command:properties.template.containers[0].command}']);
  const executions = runAz(['containerapp', 'job', 'execution', 'list', '-g', resourceGroup,
    '-n', probeJobName, '--query', '[].{status:properties.status,startTime:properties.startTime,endTime:properties.endTime}']);
  return verifyPrivateReleaseSnapshot({ environment, storage, endpoints, probeJob, executions,
    expectedEnvironmentId: environmentId, expectedEndpointSubnetId: endpointSubnetId,
    runtimeIdentityResourceId });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyPrivateReleaseFromAzure({ resourceGroup: process.env.AZURE_RESOURCE_GROUP,
      environmentId: process.env.CASE_MANAGER_PRIVATE_ENVIRONMENT_ID,
      endpointSubnetId: process.env.CASE_MANAGER_PRIVATE_ENDPOINT_SUBNET_ID,
      runtimeIdentityResourceId: process.env.RUNTIME_IDENTITY_RESOURCE_ID });
    process.stdout.write('verified=true\n');
  } catch (error) {
    console.error('case_manager_private_release_blocked', error.message);
    process.exitCode = 1;
  }
}
