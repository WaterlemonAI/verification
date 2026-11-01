targetScope = 'resourceGroup'

@description('Keep the AI7 UAE Azure OpenAI account in UAE North.')
param location string = 'uaenorth'

@description('Globally unique Azure OpenAI account and endpoint subdomain name.')
param accountName string = 'aoai-ai7uae-uaen-001'

@description('Existing dedicated API runtime managed identity.')
param runtimeIdentityName string = 'id-ai7uae-api-runtime'

@description('Leave blank to create the account without a model. Use Standard only when regional pay-per-token quota is available; GlobalStandard can process outside the UAE.')
@allowed([
  ''
  'Standard'
  'GlobalStandard'
])
param modelSkuName string = ''

@description('Deployment name used by the API after model validation.')
param modelDeploymentName string = 'ai7uae-gpt-5-mini'

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

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (!empty(modelSkuName)) {
  name: modelDeploymentName
  parent: openAi
  sku: {
    name: modelSkuName
    capacity: 10
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5-mini'
      version: '2025-08-07'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output accountId string = openAi.id
output endpoint string = openAi.properties.endpoint
output deployedModelName string = empty(modelSkuName) ? '' : modelDeploymentName
