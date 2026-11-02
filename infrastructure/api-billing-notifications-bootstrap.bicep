targetScope = 'resourceGroup'

@description('One-time privileged creation of the billing notification job. The regular API deployment owns later updates.')
param location string = 'uaenorth'

@description('Existing digest-pinned API image. This bootstrap schedule is parked until the regular API deployment supplies the new image.')
param image string

param environmentId string
param runtimeIdentityResourceId string
param runtimeIdentityClientId string
param acrLoginServer string
param keyVaultUri string
param reportStorageName string = 'stai7uaereportsuaen001'

resource billingNotificationsJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-ai7uae-billing-notifications'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${runtimeIdentityResourceId}': {} } }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 300
      replicaRetryLimit: 0
      scheduleTriggerConfig: { cronExpression: '0 0 1 1 *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [ { server: acrLoginServer, identity: runtimeIdentityResourceId } ]
      secrets: [
        { name: 'platform-smtp-password', keyVaultUrl: '${keyVaultUri}secrets/platform-smtp-password', identity: runtimeIdentityResourceId }
      ]
    }
    template: {
      containers: [
        {
          name: 'billing-notifications'
          image: image
          command: [ 'node', 'scripts/send-billing-notifications.mjs' ]
          env: [
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: runtimeIdentityClientId }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE_URL', value: 'https://${reportStorageName}.table.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE', value: 'AdverseMediaReports' }
            { name: 'PLATFORM_SMTP_HOST', value: 'smtpout.secureserver.net' }
            { name: 'PLATFORM_SMTP_PORT', value: '465' }
            { name: 'PLATFORM_SMTP_USER', value: 'notify@kycprobe.com' }
            { name: 'PLATFORM_SMTP_PASSWORD', secretRef: 'platform-smtp-password' }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}
