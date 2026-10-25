targetScope = 'resourceGroup'

@description('Location for the dedicated AI7 UAE adverse-media report store.')
param location string = 'uaenorth'

@description('Globally unique storage account used only for AI7 adverse-media PDF reports.')
param storageAccountName string = 'stai7uaereportsuaen001'

@description('Resource ID of the existing dedicated AI7 UAE API runtime identity.')
param apiRuntimeIdentityResourceId string

var reportContainerName = 'adverse-media-reports'
var reportTableName = 'AdverseMediaReports'
var blobContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var tableContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')

resource apiRuntimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
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
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 90 }
    containerDeleteRetentionPolicy: { enabled: true, days: 90 }
  }
}

resource reportContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: reportContainerName
  properties: { publicAccess: 'None' }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource reportTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: reportTableName
}

resource apiCanWriteBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, blobContributorRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: blobContributorRoleDefinitionId
    principalId: apiRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiCanWriteTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, tableContributorRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: tableContributorRoleDefinitionId
    principalId: apiRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = storage.name
output blobServiceUrl string = storage.properties.primaryEndpoints.blob
output tableServiceUrl string = storage.properties.primaryEndpoints.table
output reportContainerName string = reportContainer.name
output reportTableName string = reportTable.name
