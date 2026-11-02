targetScope = 'resourceGroup'

@description('Keep the AI7 UAE Azure OpenAI account in UAE North.')
param location string = 'uaenorth'

@description('Globally unique Azure OpenAI account and endpoint subdomain name.')
param accountName string = 'aoai-ai7uae-uaen-001'

@description('Existing dedicated API runtime managed identity.')
param runtimeIdentityName string = 'id-ai7uae-api-runtime'

var openAiUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
}

resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource runtimeCanInvoke 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openAi.id, runtimeIdentity.id, openAiUserRole)
  scope: openAi
  properties: {
    roleDefinitionId: openAiUserRole
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output accountId string = openAi.id
output endpoint string = openAi.properties.endpoint
