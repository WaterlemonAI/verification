targetScope = 'resourceGroup'

@description('Approved KYCProbe UAE North location.')
param location string = 'uaenorth'

@description('New VNet-integrated Container Apps environment ID. Never pass the live environment ID.')
param privateEnvironmentId string

@description('Exact immutable API image from the reviewed build, including @sha256 digest.')
param apiImage string

@description('KYCProbe API runtime managed identity ID; no new role assignments are made here.')
param runtimeIdentityResourceId string

@description('KYCProbe API runtime managed identity client ID.')
param runtimeIdentityClientId string

@description('Existing KYCProbe container registry login server.')
param acrLoginServer string

@description('Dedicated Case Manager storage account name from the private platform preview.')
param caseManagerStorageName string = 'stai7uaecasesuaen001'

@description('Approved private endpoint CIDR in the new KYCProbe VNet.')
param privateEndpointCidr string = '10.244.2.0/27'

resource privateProbe 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-ai7uae-case-manager-private-probe'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${runtimeIdentityResourceId}': {} }
  }
  properties: {
    environmentId: privateEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [ { server: acrLoginServer, identity: runtimeIdentityResourceId } ]
    }
    template: {
      containers: [
        {
          name: 'private-path-probe'
          image: apiImage
          command: [ 'node', 'scripts/probe-case-manager-private-path.mjs' ]
          env: [
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: runtimeIdentityClientId }
            { name: 'CASE_MANAGER_BLOB_URL', value: 'https://${caseManagerStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'CASE_MANAGER_TABLE_URL', value: 'https://${caseManagerStorageName}.table.${environment().suffixes.storage}' }
            { name: 'CASE_MANAGER_QUEUE_URL', value: 'https://${caseManagerStorageName}.queue.${environment().suffixes.storage}' }
            { name: 'CASE_MANAGER_PRIVATE_ENDPOINT_CIDR', value: privateEndpointCidr }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

output probeJobId string = privateProbe.id
