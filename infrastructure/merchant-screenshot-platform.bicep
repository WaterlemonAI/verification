targetScope = 'resourceGroup'

@description('UAE North region used by the isolated AI7 merchant screenshot worker.')
param location string = 'uaenorth'

@description('Name of the existing AI7 UAE Azure Container Registry.')
param acrName string = 'acrai7uaeuaen001'

@description('Dedicated user-assigned identity for the isolated screenshot worker.')
param identityName string = 'id-ai7uae-merchant-screenshot-uaen-001'

var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource canPullImages 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, acrPullRoleDefinitionId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output identityResourceId string = identity.id
output identityPrincipalId string = identity.properties.principalId
