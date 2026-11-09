targetScope = 'resourceGroup'

@description('Existing private Case Manager storage account. Flo uses separate child resources.')
param storageAccountName string = 'stai7uaecasesuaen001'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource floEvidence 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'flo-evidence'
  properties: { publicAccess: 'None' }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource floCases 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'FloCases'
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource floJobs 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'flo-jobs'
}

resource floCallbacks 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'flo-callbacks'
}

resource floDeadLetters 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'flo-dead-letter'
}

output containerName string = floEvidence.name
output tableName string = floCases.name
output jobsQueueName string = floJobs.name
output callbacksQueueName string = floCallbacks.name
output deadLetterQueueName string = floDeadLetters.name
