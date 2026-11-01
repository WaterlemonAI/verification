targetScope = 'resourceGroup'

@description('Existing UAE North Azure OpenAI account.')
param accountName string = 'aoai-ai7uae-uaen-001'

@description('Global Standard processes prompts and responses outside the UAE when Azure routes them globally.')
@allowed([
  'GlobalStandard'
])
param modelSkuName string = 'GlobalStandard'

@description('Deployment name used after model validation.')
param modelDeploymentName string = 'ai7uae-gpt-5-mini'

resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
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
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output deployedModelName string = modelDeployment.name
