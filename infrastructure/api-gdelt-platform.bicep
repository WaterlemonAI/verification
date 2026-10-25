targetScope = 'resourceGroup'

@description('Location for the dedicated AI7 UAE GDELT ingestion resources.')
param location string = 'uaenorth'

@description('Globally unique storage account used only by the AI7 UAE GDELT archive.')
param storageAccountName string = 'stai7uaegdeltuaen001'

@description('Dedicated managed identity for the GDELT ingestion job.')
param ingestionIdentityName string = 'id-ai7uae-gdelt-ingest'

@description('Resource ID of the existing AI7 UAE API runtime identity.')
param apiRuntimeIdentityResourceId string

@description('Resource ID of the existing AI7 UAE container registry.')
param registryId string

var archiveContainerName = 'gdelt-archive'
var indexTableName = 'GdeltEntityMentions'
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var blobContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var tableContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var blobReaderRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var tableReaderRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '76199698-9eea-4c19-bc75-cec21354c6b6')

resource ingestionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: ingestionIdentityName
  location: location
}

resource apiRuntimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(apiRuntimeIdentityResourceId, '/'))
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
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
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource archiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: archiveContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource indexTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: indexTableName
}

resource ingestionCanPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, ingestionIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: ingestionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource ingestionCanWriteBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, ingestionIdentity.id, blobContributorRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: blobContributorRoleDefinitionId
    principalId: ingestionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource ingestionCanWriteTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, ingestionIdentity.id, tableContributorRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: tableContributorRoleDefinitionId
    principalId: ingestionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiCanReadBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, blobReaderRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: blobReaderRoleDefinitionId
    principalId: apiRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiCanReadTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, tableReaderRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: tableReaderRoleDefinitionId
    principalId: apiRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = storage.name
output storageAccountUrl string = storage.properties.primaryEndpoints.blob
output ingestionIdentityResourceId string = ingestionIdentity.id
output ingestionIdentityClientId string = ingestionIdentity.properties.clientId
output archiveContainerName string = archiveContainer.name
output indexTableName string = indexTable.name
