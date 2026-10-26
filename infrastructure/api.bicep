targetScope = 'resourceGroup'

@description('UAE North region used by the AI7 UAE Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned API image reference.')
param image string

@description('Digest-pinned isolated merchant screenshot worker image reference.')
param merchantScreenshotWorkerImage string

@description('Resource ID of the existing AI7 UAE Container Apps environment.')
param environmentId string

@description('Resource ID of the dedicated API runtime managed identity.')
param runtimeIdentityResourceId string

@description('Client ID of the dedicated API runtime managed identity.')
param runtimeIdentityClientId string

@description('Azure Container Registry login server.')
param acrLoginServer string

@description('URI of the dedicated API Key Vault.')
param keyVaultUri string

@description('Resource ID of the managed certificate for api.ai7uae.com. Leave blank until DNS validation is complete.')
param apiCertificateId string = ''

@description('Name of the API Container App.')
param containerAppName string = 'ca-ai7uae-api'

@description('Name of the isolated merchant screenshot worker Container App.')
param merchantScreenshotWorkerName string = 'ca-ai7uae-merchant-screenshot'

@description('Dedicated storage account for durable adverse-media deep-research jobs.')
param deepResearchStorageName string = 'stai7uaejobsuaen001'

@description('Dedicated storage account for the local GDELT archive and entity index.')
param gdeltStorageName string = 'stai7uaegdeltuaen001'

@description('Dedicated storage account for permanent adverse-media PDF reports.')
param reportStorageName string = 'stai7uaereportsuaen001'

var deepResearchQueueName = 'adverse-media-deep-research'
var customDomains = empty(apiCertificateId) ? [] : [
  {
    name: 'api.ai7uae.com'
    bindingType: 'SniEnabled'
    certificateId: apiCertificateId
  }
]

resource merchantScreenshotWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-ai7uae-merchant-screenshot-uaen-001'
}

resource merchantScreenshotWorker 'Microsoft.App/containerApps@2024-03-01' = {
  name: merchantScreenshotWorkerName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${merchantScreenshotWorkerIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        allowInsecure: false
        targetPort: 8081
        transport: 'Auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: merchantScreenshotWorkerIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'merchant-screenshot-worker'
          image: merchantScreenshotWorkerImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8081' }
            { name: 'MERCHANT_SCREENSHOT_ISOLATED_WORKER', value: 'true' }
            { name: 'MERCHANT_SCREENSHOT_ESTIMATED_COST_PER_CAPTURE_USD', value: '0.001' }
            { name: 'MERCHANT_SCREENSHOT_MAXIMUM_CAPTURES', value: '4' }
            { name: 'MERCHANT_SCREENSHOT_NAVIGATION_TIMEOUT_MS', value: '12000' }
            { name: 'MERCHANT_SCREENSHOT_MAXIMUM_HEIGHT', value: '900' }
            { name: 'MERCHANT_SCREENSHOT_MAXIMUM_BYTES', value: '4194304' }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8081, scheme: 'HTTP' }
              initialDelaySeconds: 20
              periodSeconds: 30
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8081, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'single-capture-per-replica'
            http: { metadata: { concurrentRequests: '1' } }
          }
        ]
      }
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'Auto'
        customDomains: customDomains
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentityResourceId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          env: [
            { name: 'API_HOSTS', value: 'api.ai7uae.com' }
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: runtimeIdentityClientId }
            { name: 'ADVERSE_MEDIA_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${deepResearchQueueName}' }
            { name: 'GDELT_STORAGE_ACCOUNT_URL', value: 'https://${gdeltStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'GDELT_ARCHIVE_CONTAINER', value: 'gdelt-archive' }
            { name: 'GDELT_INDEX_TABLE', value: 'GdeltEntityMentions' }
            { name: 'ADVERSE_MEDIA_REPORT_BLOB_URL', value: 'https://${reportStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE_URL', value: 'https://${reportStorageName}.table.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_CONTAINER', value: 'adverse-media-reports' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE', value: 'AdverseMediaReports' }
            { name: 'AZURE_REGION_DISPLAY', value: 'Microsoft Azure UAE North' }
            { name: 'API_PUBLIC_BASE_URL', value: 'https://api.ai7uae.com' }
            { name: 'MERCHANT_SCREENSHOT_WORKER_URL', value: 'https://${merchantScreenshotWorker.properties.configuration.ingress.fqdn}' }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 30
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 2
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

output fqdn string = api.properties.configuration.ingress.fqdn
output customDomainVerificationId string = api.properties.customDomainVerificationId
output latestRevisionName string = api.properties.latestRevisionName
output merchantScreenshotWorkerFqdn string = merchantScreenshotWorker.properties.configuration.ingress.fqdn
output merchantScreenshotWorkerLatestRevisionName string = merchantScreenshotWorker.properties.latestRevisionName
