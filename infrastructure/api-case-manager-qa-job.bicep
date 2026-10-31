targetScope = 'resourceGroup'

@description('Approved KYCProbe UAE North location.')
param location string = 'uaenorth'

@description('New VNet-integrated Container Apps environment ID.')
param privateEnvironmentId string

@description('Exact immutable API image, including @sha256 digest.')
param apiImage string

@description('KYCProbe API runtime managed identity ID.')
param runtimeIdentityResourceId string

@description('KYCProbe API runtime managed identity client ID.')
param runtimeIdentityClientId string

@description('Existing KYCProbe container registry login server.')
param acrLoginServer string

@description('Existing KYCProbe API Key Vault URI.')
param keyVaultUri string

@description('Dedicated private Case Manager storage account.')
param caseManagerStorageName string = 'stai7uaecasesuaen001'

@description('Run the bounded 200 QPM synthetic load comparison after smoke passes.')
param runLoad bool = false

@description('Run bounded synthetic OCR/BSA reconciliation on an isolated QA load queue.')
param runAsync bool = false

@description('Replay mixed synthetic final responses through private Azure case storage.')
param runMixed bool = false

@description('Run a guarded 50,000-case private Azure storage and retirement trial.')
param runScale bool = false

@description('One-time guarded deletion of synthetic QA case copies from the October 30 executions.')
param cleanupOrphans bool = false

@description('Seconds per capture-off and capture-on phase (30-300).')
@minValue(30)
@maxValue(300)
param phaseSeconds int = 120

@description('Synthetic request rate per minute (1-200).')
@minValue(1)
@maxValue(200)
param requestsPerMinute int = 200

resource qaJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-ai7uae-cm-azure-qa'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${runtimeIdentityResourceId}': {} }
  }
  properties: {
    environmentId: privateEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: runScale ? 3600 : 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [ { server: acrLoginServer, identity: runtimeIdentityResourceId } ]
      secrets: [
        { name: 'case-data-key-v1', keyVaultUrl: '${keyVaultUri}secrets/case-manager-data-key-v1', identity: runtimeIdentityResourceId }
      ]
    }
    template: {
      containers: [
        {
          name: 'case-manager-azure-qa'
          image: apiImage
          command: [ 'node', 'scripts/qa-case-manager-azure.mjs' ]
          env: [
            { name: 'NODE_ENV', value: 'test' }
            { name: 'CASE_MANAGER_QA_MODE', value: 'true' }
            { name: 'CASE_MANAGER_QA_LOAD', value: runLoad ? 'true' : 'false' }
            { name: 'CASE_MANAGER_QA_ASYNC', value: runAsync ? 'true' : 'false' }
            { name: 'CASE_MANAGER_QA_MIXED', value: runMixed ? 'true' : 'false' }
            { name: 'CASE_MANAGER_QA_SCALE', value: runScale ? 'true' : 'false' }
            { name: 'CASE_MANAGER_QA_CLEANUP', value: cleanupOrphans ? 'true' : 'false' }
            { name: 'CASE_MANAGER_QA_SECONDS', value: string(phaseSeconds) }
            { name: 'CASE_MANAGER_QA_QPM', value: string(requestsPerMinute) }
            { name: 'CASE_MANAGER_ENABLED', value: 'true' }
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: runtimeIdentityClientId }
            { name: 'CASE_MANAGER_BLOB_URL', value: 'https://${caseManagerStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'CASE_MANAGER_TABLE_URL', value: 'https://${caseManagerStorageName}.table.${environment().suffixes.storage}' }
            { name: 'CASE_MANAGER_QUEUE_URL', value: 'https://${caseManagerStorageName}.queue.${environment().suffixes.storage}' }
            { name: 'CASE_MANAGER_TABLE_NAME', value: 'CaseManagerQaMetadata' }
            { name: 'CASE_MANAGER_CONTAINER_NAME', value: 'case-manager-qa-private' }
            { name: 'CASE_MANAGER_RECONCILE_QUEUE_NAME', value: 'case-manager-qa-reconcile' }
            { name: 'CASE_MANAGER_DEAD_LETTER_QUEUE_NAME', value: 'case-manager-qa-dead-letter' }
            { name: 'CASE_MANAGER_DATA_KEY_V1_HEX', secretRef: 'case-data-key-v1' }
            { name: 'CASE_MANAGER_ACTIVE_KEY_VERSION', value: '1' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
    }
  }
}

output qaJobId string = qaJob.id
