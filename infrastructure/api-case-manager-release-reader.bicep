targetScope = 'resourceGroup'

@description('Object ID of the existing GitHub API deployment identity. No runtime data access is granted.')
param deployerPrincipalId string

@description('Dedicated Case Manager storage account name.')
param caseManagerStorageName string = 'stai7uaecasesuaen001'

@description('Existing private-path probe job name.')
param probeJobName string = 'caj-ai7uae-cm-private-probe'

var readerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')

resource caseStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: caseManagerStorageName
}

resource blobEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' existing = {
  name: 'pe-ai7uae-cases-blob-uaen-001'
}

resource tableEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' existing = {
  name: 'pe-ai7uae-cases-table-uaen-001'
}

resource queueEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' existing = {
  name: 'pe-ai7uae-cases-queue-uaen-001'
}

resource probeJob 'Microsoft.App/jobs@2024-03-01' existing = {
  name: probeJobName
}

resource storageRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(caseStorage.id, deployerPrincipalId, readerRoleId)
  scope: caseStorage
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
  }
}

resource blobEndpointRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(blobEndpoint.id, deployerPrincipalId, readerRoleId)
  scope: blobEndpoint
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
  }
}

resource tableEndpointRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(tableEndpoint.id, deployerPrincipalId, readerRoleId)
  scope: tableEndpoint
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
  }
}

resource queueEndpointRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(queueEndpoint.id, deployerPrincipalId, readerRoleId)
  scope: queueEndpoint
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
  }
}

resource probeRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(probeJob.id, deployerPrincipalId, readerRoleId)
  scope: probeJob
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
  }
}
