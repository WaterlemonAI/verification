targetScope = 'resourceGroup'

@description('Location for the dedicated private adverse-media JSON retention account.')
param location string = 'uaenorth'

@description('Globally unique storage account used only for 365-day adverse-media request/response JSON.')
param storageAccountName string = 'stai7uaejsonuaen001'

@description('Resource ID of the existing AI7 UAE API runtime identity.')
param apiRuntimeIdentityResourceId string

var blobContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

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
}

resource jsonContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'adverse-media-json'
  properties: { publicAccess: 'None' }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'expire-adverse-media-json-after-365-days'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ 'adverse-media-json/' ]
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: 365 }
              }
            }
          }
        }
      ]
    }
  }
}

resource apiCanWriteJson 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiRuntimeIdentity.id, blobContributorRoleDefinitionId)
  scope: storage
  properties: {
    roleDefinitionId: blobContributorRoleDefinitionId
    principalId: apiRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = storage.name
output blobServiceUrl string = storage.properties.primaryEndpoints.blob
output containerName string = jsonContainer.name
