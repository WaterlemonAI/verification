targetScope = 'resourceGroup'

@description('Existing storage account that holds the API queues.')
param queueStorageName string

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: queueStorageName
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource incidentQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'adverse-media-incident'
}

resource incidentDeadLetterQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'adverse-media-incident-deadletter'
}

output queueUrl string = 'https://${queueStorageName}.queue.${environment().suffixes.storage}/adverse-media-incident'
output deadLetterQueueUrl string = 'https://${queueStorageName}.queue.${environment().suffixes.storage}/adverse-media-incident-deadletter'
