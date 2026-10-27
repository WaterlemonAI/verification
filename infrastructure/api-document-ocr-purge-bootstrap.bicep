targetScope = 'resourceGroup'

@description('One-time bootstrap of the dedicated OCR purge job. The normal API deployment owns later updates.')
param location string = 'uaenorth'

@description('Digest-pinned document OCR worker image from a successful main-branch API build.')
param documentOcrWorkerImage string

@description('Existing AI7 UAE Container Apps environment resource ID.')
param environmentId string

@description('Existing dedicated OCR worker identity resource ID.')
param workerIdentityResourceId string

@description('Existing AI7 UAE ACR login server.')
param acrLoginServer string

param documentOcrStorageName string = 'stai7uaeocruaen001'
param reportStorageName string = 'stai7uaereportsuaen001'

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(workerIdentityResourceId, '/'))
}

resource purgeJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-ai7uae-document-ocr-purge'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workerIdentity.id}': {} }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 3600
      replicaRetryLimit: 2
      scheduleTriggerConfig: { cronExpression: '15 * * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [ { server: acrLoginServer, identity: workerIdentity.id } ]
    }
    template: {
      containers: [
        {
          name: 'document-ocr-purge'
          image: documentOcrWorkerImage
          command: [ 'node', 'scripts/purge-document-ocr.mjs' ]
          env: [
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: workerIdentity.properties.clientId }
            { name: 'DOCUMENT_OCR_STORAGE_BLOB_URL', value: 'https://${documentOcrStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE_URL', value: 'https://${reportStorageName}.table.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE', value: 'AdverseMediaReports' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
    }
  }
}

output purgeJobResourceId string = purgeJob.id
