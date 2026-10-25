targetScope = 'resourceGroup'

@description('UAE North region used by the AI7 UAE Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned API image containing the GDELT ingestion command.')
param image string

@description('Resource ID of the existing AI7 UAE Container Apps environment.')
param environmentId string

@description('Resource ID of the dedicated GDELT ingestion managed identity.')
param ingestionIdentityResourceId string

@description('Client ID of the dedicated GDELT ingestion managed identity.')
param ingestionIdentityClientId string

@description('Azure Container Registry login server.')
param acrLoginServer string

@description('Dedicated GDELT archive storage account.')
param storageAccountName string = 'stai7uaegdeltuaen001'

@description('Daily UTC schedule for incremental ingestion. Default is 01:30 UTC.')
param cronExpression string = '30 1 * * *'

@description('Name of the scheduled Container Apps job.')
param jobName string = 'caj-ai7uae-gdelt-ingest'

resource ingestionJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${ingestionIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 21600
      replicaRetryLimit: 2
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: ingestionIdentityResourceId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'gdelt-ingest'
          image: image
          command: [ 'node', 'scripts/gdelt-ingest.mjs' ]
          env: [
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: ingestionIdentityClientId }
            { name: 'GDELT_STORAGE_ACCOUNT_URL', value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}' }
            { name: 'GDELT_ARCHIVE_CONTAINER', value: 'gdelt-archive' }
            { name: 'GDELT_INDEX_TABLE', value: 'GdeltEntityMentions' }
            { name: 'GDELT_INITIAL_LOOKBACK_HOURS', value: '72' }
            { name: 'GDELT_INCREMENTAL_OVERLAP_HOURS', value: '36' }
            { name: 'GDELT_MAX_FILES_PER_RUN', value: '400' }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

output jobName string = ingestionJob.name
output jobResourceId string = ingestionJob.id
