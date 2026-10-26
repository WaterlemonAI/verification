targetScope = 'resourceGroup'

@description('Location for the dedicated AI7 UAE deep-research queue.')
param location string = 'uaenorth'

@description('Resource ID of the dedicated API runtime managed identity.')
param runtimeIdentityResourceId string

@description('Dedicated storage account for adverse-media deep-research jobs.')
param storageAccountName string = 'stai7uaejobsuaen001'

var queueName = 'adverse-media-deep-research'
var deadLetterQueueName = 'adverse-media-deep-research-deadletter'
var formsQueueName = 'forms-submissions'
var queueContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Enabled'
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: queueName
}

resource deadLetterQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: deadLetterQueueName
}

resource formsQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: formsQueueName
}

resource queueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, runtimeIdentityResourceId, queueContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: queueContributorRoleId
    principalId: reference(runtimeIdentityResourceId, '2023-01-31').principalId
    principalType: 'ServicePrincipal'
  }
}

output queueUrl string = '${storage.properties.primaryEndpoints.queue}${queueName}'
output deadLetterQueueUrl string = '${storage.properties.primaryEndpoints.queue}${deadLetterQueueName}'
output formsQueueUrl string = '${storage.properties.primaryEndpoints.queue}${formsQueueName}'
