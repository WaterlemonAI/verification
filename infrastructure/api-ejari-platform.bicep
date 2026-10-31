targetScope = 'resourceGroup'

@description('Approved UAE North location for Ejari storage and worker identity.')
param location string = 'uaenorth'
@description('Dedicated private Ejari storage account.')
param storageAccountName string = 'stai7uaeejariuaen001'
@description('Dedicated Ejari worker identity.')
param workerIdentityName string = 'id-ai7uae-ejari-worker-uaen-001'
param apiRuntimeIdentityResourceId string
param registryId string
param keyVaultId string
@description('Private endpoint subnet in the API Container Apps VNet.')
param privateEndpointSubnetId string

var blobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var tableContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var queueContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var secretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: last(split(apiRuntimeIdentityResourceId, '/')) }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: last(split(registryId, '/')) }
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: last(split(keyVaultId, '/')) }
resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: workerIdentityName
  location: location
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
    publicNetworkAccess: 'Disabled'
  }
}
var groups = ['blob', 'table', 'queue']
var zoneNames = [for group in groups: 'privatelink.${group}.${environment().suffixes.storage}']
resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' existing = [for zone in zoneNames: { name: zone }]
resource endpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for group in groups: {
  name: 'pe-ai7uae-ejari-${group}-uaen-001'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [{ name: 'ejari-${group}', properties: { privateLinkServiceId: storage.id, groupIds: [group] } }]
  }
}]
resource dnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (group, index) in groups: {
  parent: endpoints[index]
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: group, properties: { privateDnsZoneId: zones[index].id } }] }
}]
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: { enabled: false }
    containerDeleteRetentionPolicy: { enabled: false }
  }
}
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { policy: { rules: [{
    name: 'ejari-blob-expiry-backstop'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['ejari-private/'] }
      actions: { baseBlob: { delete: { daysAfterCreationGreaterThan: 31 } } }
    }
  }] } }
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'ejari-private'
  properties: { publicAccess: 'None' }
}
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = { parent: storage, name: 'default' }
resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = { parent: queueService, name: 'ejari-jobs' }
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = { parent: storage, name: 'default' }
resource jobs 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = { parent: tableService, name: 'EjariJobs' }
resource expiry 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = { parent: tableService, name: 'EjariExpiry' }
resource apiBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiIdentity.id, blobContributorRole)
  scope: storage
  properties: { roleDefinitionId: blobContributorRole, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource apiQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiIdentity.id, queueContributorRole)
  scope: storage
  properties: { roleDefinitionId: queueContributorRole, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource apiTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiIdentity.id, tableContributorRole)
  scope: storage
  properties: { roleDefinitionId: tableContributorRole, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, blobContributorRole)
  scope: storage
  properties: { roleDefinitionId: blobContributorRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, queueContributorRole)
  scope: storage
  properties: { roleDefinitionId: queueContributorRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, tableContributorRole)
  scope: storage
  properties: { roleDefinitionId: tableContributorRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, acrPullRole)
  scope: registry
  properties: { roleDefinitionId: acrPullRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workerIdentity.id, secretsUserRole)
  scope: keyVault
  properties: { roleDefinitionId: secretsUserRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
output blobUrl string = storage.properties.primaryEndpoints.blob
output workerIdentityResourceId string = workerIdentity.id
output workerIdentityClientId string = workerIdentity.properties.clientId
