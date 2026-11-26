targetScope = 'resourceGroup'

@description('UAE North region used by the GDELT archive and Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned API image containing the GDELT backfill command.')
param image string

@description('Resource ID of the existing AI7 UAE Container Apps environment.')
param environmentId string

@description('Resource ID of the existing GDELT ingestion managed identity.')
param ingestionIdentityResourceId string

@description('Client ID of the existing GDELT ingestion managed identity.')
param ingestionIdentityClientId string

@description('Azure Container Registry login server.')
param acrLoginServer string

@description('Existing dedicated GDELT archive storage account.')
param storageAccountName string = 'stai7uaegdeltuaen001'

@description('Saturday 22:00 UAE time, evaluated as Saturday 18:00 UTC.')
param cronExpression string = '0 18 * * 6'

@description('Rolling historical target in days.')
param targetDays int = 365

@description('Name of the separate weekly backfill job.')
param jobName string = 'caj-ai7uae-gdelt-backfill'

@description('Enable V2 manifest and summary dual writes after V2 tables exist.')
param v2DualWrite bool = false

resource backfillJob 'Microsoft.App/jobs@2024-03-01' = {
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
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 7200
      replicaRetryLimit: 1
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
          name: 'gdelt-backfill'
          image: image
          command: [ 'node', 'scripts/gdelt-backfill.mjs' ]
          env: [
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: ingestionIdentityClientId }
            { name: 'GDELT_STORAGE_ACCOUNT_URL', value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}' }
            { name: 'GDELT_ARCHIVE_CONTAINER', value: 'gdelt-archive' }
            { name: 'GDELT_INDEX_TABLE', value: 'GdeltEntityMentions' }
            { name: 'GDELT_V2_SUMMARY_TABLE', value: 'GdeltEntitySummaryV2' }
            { name: 'GDELT_V2_MANIFEST_TABLE', value: 'GdeltIntervalManifestV2' }
            { name: 'GDELT_V2_DUAL_WRITE', value: v2DualWrite ? 'true' : 'false' }
            { name: 'GDELT_BACKFILL_TARGET_DAYS', value: string(targetDays) }
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

output jobName string = backfillJob.name
output jobResourceId string = backfillJob.id
