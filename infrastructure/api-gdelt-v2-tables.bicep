targetScope = 'resourceGroup'

@description('Existing dedicated UAE North GDELT storage account. This template adds tables only.')
param storageAccountName string = 'stai7uaegdeltuaen001'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource summary 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'GdeltEntitySummaryV2'
}

resource manifest 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'GdeltIntervalManifestV2'
}

output summaryTableId string = summary.id
output manifestTableId string = manifest.id
