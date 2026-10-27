targetScope = 'resourceGroup'

@description('Approved UAE region for document OCR processing.')
param location string = 'uaenorth'

@description('Dedicated private storage for encrypted OCR input, text, results and artifacts.')
param storageAccountName string = 'stai7uaeocruaen001'

@description('Dedicated paid Document Intelligence resource; existing BSA resource is untouched.')
param documentIntelligenceName string = 'doc-ai7uae-ocr-uaen-001'

@description('Dedicated OCR worker identity.')
param workerIdentityName string = 'id-ai7uae-ocr-worker-uaen-001'

param apiRuntimeIdentityResourceId string
param registryId string
param keyVaultId string

@description('Existing AI7 report storage hosts the customer usage table used for OCR settlement.')
param reportStorageName string = 'stai7uaereportsuaen001'

var blobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var queueContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var tableContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var cognitiveServicesUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(apiRuntimeIdentityResourceId, '/'))
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: last(split(keyVaultId, '/'))
}
resource reportStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: reportStorageName
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
    deleteRetentionPolicy: { enabled: false }
    containerDeleteRetentionPolicy: { enabled: false }
  }
}
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-ocr-data-after-30-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: [ 'blockBlob' ], prefixMatch: [ 'document-ocr-private/' ] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } }
          }
        }
      ]
    }
  }
}
resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'document-ocr-private'
  properties: { publicAccess: 'None' }
}
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource jobsQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'document-ocr-jobs'
}
resource deadLetterQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'document-ocr-dead-letter'
}
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource jobsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'DocumentOcrJobs'
}
resource documentIntelligence 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: documentIntelligenceName
  location: location
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: documentIntelligenceName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}
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
resource workerUsageTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(reportStorage.id, workerIdentity.id, tableContributorRole)
  scope: reportStorage
  properties: { roleDefinitionId: tableContributorRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, acrPullRole)
  scope: registry
  properties: { roleDefinitionId: acrPullRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerAnalyze 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, workerIdentity.id, cognitiveServicesUserRole)
  scope: documentIntelligence
  properties: { roleDefinitionId: cognitiveServicesUserRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workerIdentity.id, keyVaultSecretsUserRole)
  scope: keyVault
  properties: { roleDefinitionId: keyVaultSecretsUserRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

output storageBlobUrl string = storage.properties.primaryEndpoints.blob
output workerIdentityResourceId string = workerIdentity.id
output workerIdentityClientId string = workerIdentity.properties.clientId
output documentIntelligenceEndpoint string = documentIntelligence.properties.endpoint
