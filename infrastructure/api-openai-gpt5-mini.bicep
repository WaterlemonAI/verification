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

resource kycprobeGuardrail 'Microsoft.CognitiveServices/accounts/raiPolicies@2024-10-01' = {
  name: 'ai7uae-kycprobe-shield-v1'
  parent: openAi
  properties: {
    basePolicyName: 'Microsoft.DefaultV2'
    mode: 'Blocking'
    contentFilters: [
      { name: 'Hate', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Hate', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Sexual', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Sexual', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Violence', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Violence', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Selfharm', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Selfharm', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
      { name: 'Jailbreak', source: 'Prompt', blocking: true, enabled: true }
      { name: 'Indirect Attack', source: 'Prompt', blocking: true, enabled: true }
      { name: 'Protected Material Text', source: 'Completion', blocking: true, enabled: true }
      { name: 'Protected Material Code', source: 'Completion', blocking: false, enabled: true }
    ]
  }
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
    raiPolicyName: kycprobeGuardrail.name
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output deployedModelName string = modelDeployment.name
