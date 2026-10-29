targetScope = 'resourceGroup'

@description('Approved location for the isolated Case Manager data plane.')
param location string = 'uaenorth'

@description('Globally unique storage account used only for encrypted Case Manager copies.')
param storageAccountName string = 'stai7uaecasesuaen001'

@description('Existing API runtime managed identity resource ID; provisioning is a separate reviewed action.')
param apiRuntimeIdentityResourceId string

@description('Private-endpoint subnet ID from the separately previewed KYCProbe VNet environment. Required; no public storage fallback.')
param privateEndpointSubnetId string

var blobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var tableContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var queueContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(apiRuntimeIdentityResourceId, '/'))
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    // No customer QA until the API runtime has a reviewed VNet/private-endpoint path.
    publicNetworkAccess: 'Disabled'
  }
}

var endpointGroups = [ 'blob', 'table', 'queue' ]
var privateZoneNames = [
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.queue.${environment().suffixes.storage}'
]

resource privateZones 'Microsoft.Network/privateDnsZones@2024-06-01' existing = [for zone in privateZoneNames: {
  name: zone
}]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for (group, index) in endpointGroups: {
  name: 'pe-ai7uae-cases-${group}-uaen-001'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'case-manager-${group}'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [group]
        }
      }
    ]
  }
}]

resource privateDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (group, index) in endpointGroups: {
  parent: privateEndpoints[index]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: group, properties: { privateDnsZoneId: privateZones[index].id } }
    ]
  }
}]

// Versioning and soft delete are disabled so an expired case cannot survive in a recoverable blob version.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: { enabled: false }
    containerDeleteRetentionPolicy: { enabled: false }
  }
}

resource cases 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'case-manager-private'
  properties: { publicAccess: 'None' }
}

resource probeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'case-manager-probe'
  properties: { publicAccess: 'None' }
}

resource qaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'case-manager-qa-private'
  properties: { publicAccess: 'None' }
}

resource qaArtifactContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'case-manager-qa-artifacts'
  properties: { publicAccess: 'None' }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource reconcileQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'case-manager-reconcile'
}
resource deadLetters 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'case-manager-dead-letter'
}
resource probeQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'case-manager-probe'
}

resource qaReconcileQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'case-manager-qa-reconcile'
}
resource qaDeadLetters 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'case-manager-qa-dead-letter'
}
resource qaLoadQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'case-manager-qa-load'
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource metadata 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'CaseManagerMetadata'
}
resource probeTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'CaseManagerProbe'
}

resource qaMetadata 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'CaseManagerQaMetadata'
}

resource qaArtifacts 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'CaseManagerQaArtifacts'
}

resource apiBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiIdentity.id, blobContributorRole)
  scope: storage
  properties: { roleDefinitionId: blobContributorRole, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource apiTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiIdentity.id, tableContributorRole)
  scope: storage
  properties: { roleDefinitionId: tableContributorRole, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource apiQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiIdentity.id, queueContributorRole)
  scope: storage
  properties: { roleDefinitionId: queueContributorRole, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

output blobUrl string = storage.properties.primaryEndpoints.blob
output tableUrl string = storage.properties.primaryEndpoints.table
output queueUrl string = storage.properties.primaryEndpoints.queue
output containerName string = cases.name
output tableName string = metadata.name
output privateEndpointIds array = [for (group, index) in endpointGroups: privateEndpoints[index].id]
