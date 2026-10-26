targetScope = 'resourceGroup'

@description('Azure region approved for bank-statement processing.')
param location string = 'uaenorth'

@description('Dedicated storage account for encrypted bank-statement jobs and artifacts.')
param storageAccountName string = 'stai7uaebsauaen001'

@description('Dedicated Azure Document Intelligence account.')
param documentIntelligenceName string = 'doc-ai7uae-bsa-uaen-001'

@allowed([ 'F0', 'S0' ])
@description('F0 is the initial no-charge live tier. Promote to S0 only after cost approval.')
param documentIntelligenceSku string = 'F0'

@description('Dedicated bank-statement worker identity.')
param workerIdentityName string = 'id-ai7uae-bsa-worker-uaen-001'

@description('Resource ID of the existing dedicated AI7 UAE API runtime identity.')
param apiRuntimeIdentityResourceId string

@description('Resource ID of the existing AI7 UAE container registry.')
param registryId string

@description('Resource ID of the existing dedicated API Key Vault.')
param keyVaultId string

var containerName = 'bank-statement-analysis'
var queueName = 'bank-statement-analysis'
var tableName = 'BankStatementAnalysis'
var blobContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var queueContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var tableContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var cognitiveServicesUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource apiRuntimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(apiRuntimeIdentityResourceId, '/'))
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: last(split(keyVaultId, '/'))
}

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
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource inputContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: { publicAccess: 'None' }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource analysisQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: queueName
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource analysisTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: tableName
}

resource documentIntelligence 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: documentIntelligenceName
  location: location
  kind: 'FormRecognizer'
  sku: { name: documentIntelligenceSku }
  properties: {
    customSubDomainName: documentIntelligenceName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource apiBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, blobContributorRoleDefinitionId)
  scope: storage
  properties: { roleDefinitionId: blobContributorRoleDefinitionId, principalId: apiRuntimeIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource apiQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, queueContributorRoleDefinitionId)
  scope: storage
  properties: { roleDefinitionId: queueContributorRoleDefinitionId, principalId: apiRuntimeIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource apiTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, tableContributorRoleDefinitionId)
  scope: storage
  properties: { roleDefinitionId: tableContributorRoleDefinitionId, principalId: apiRuntimeIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource workerBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, blobContributorRoleDefinitionId)
  scope: storage
  properties: { roleDefinitionId: blobContributorRoleDefinitionId, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource workerQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, queueContributorRoleDefinitionId)
  scope: storage
  properties: { roleDefinitionId: queueContributorRoleDefinitionId, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource workerTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, tableContributorRoleDefinitionId)
  scope: storage
  properties: { roleDefinitionId: tableContributorRoleDefinitionId, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource workerCanPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: { roleDefinitionId: acrPullRoleDefinitionId, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource workerCanAnalyze 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, workerIdentity.id, cognitiveServicesUserRoleDefinitionId)
  scope: documentIntelligence
  properties: { roleDefinitionId: cognitiveServicesUserRoleDefinitionId, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource workerCanReadEncryptionKey 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: { roleDefinitionId: keyVaultSecretsUserRoleDefinitionId, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

output storageAccountName string = storage.name
output storageBlobUrl string = storage.properties.primaryEndpoints.blob
output workerIdentityResourceId string = workerIdentity.id
output workerIdentityClientId string = workerIdentity.properties.clientId
output documentIntelligenceEndpoint string = documentIntelligence.properties.endpoint
output documentIntelligenceSku string = documentIntelligence.sku.name
