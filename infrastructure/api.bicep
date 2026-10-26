targetScope = 'resourceGroup'

@description('UAE North region used by the AI7 UAE Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned API image reference.')
param image string

@description('Digest-pinned isolated merchant screenshot worker image reference.')
param merchantScreenshotWorkerImage string

@description('Digest-pinned bank statement analysis worker image reference.')
param bankStatementWorkerImage string

@description('Resource ID of the existing AI7 UAE Container Apps environment.')
param environmentId string

@description('Resource ID of the dedicated API runtime managed identity.')
param runtimeIdentityResourceId string

@description('Client ID of the dedicated API runtime managed identity.')
param runtimeIdentityClientId string

@description('Name of the dedicated bank statement worker managed identity.')
param bankStatementWorkerIdentityName string = 'id-ai7uae-bsa-worker-uaen-001'

@description('Azure Container Registry login server.')
param acrLoginServer string

@description('URI of the dedicated API Key Vault.')
param keyVaultUri string

@description('Dedicated bank statement storage account name.')
param bankStatementStorageName string = 'stai7uaebsauaen001'

@description('Azure Document Intelligence endpoint approved in UAE North.')
param bankStatementDocumentEndpoint string = 'https://doc-ai7uae-bsa-uaen-001.cognitiveservices.azure.com/'

@description('Resource ID of the managed certificate for api.ai7uae.com. Leave blank until DNS validation is complete.')
param apiCertificateId string = ''

@description('Resource ID of the managed certificate for app.kycprobe.com.')
param appCertificateId string = ''

@description('Name of the API Container App.')
param containerAppName string = 'ca-ai7uae-api'

@description('Dedicated AI7 UAE Log Analytics workspace used by Container Apps.')
param logAnalyticsWorkspaceName string = 'log-ai7uae-web-uaen-001'

@description('Operations mailbox for API availability alerts.')
param apiAlertEmail string = 'notify@kycprobe.com'

@description('Name of the isolated merchant screenshot worker Container App.')
param merchantScreenshotWorkerName string = 'ca-ai7uae-merchant-screenshot'

@description('Name of the isolated bank statement worker Container App.')
param bankStatementWorkerName string = 'ca-ai7uae-bsa-worker'

@description('Dedicated storage account for durable adverse-media deep-research jobs.')
param deepResearchStorageName string = 'stai7uaejobsuaen001'

@description('Keep deep-research submissions and worker paused until queued legacy jobs are inspected.')
param enableDeepResearchWorker bool = false

@description('Dedicated storage account for the local GDELT archive and entity index.')
param gdeltStorageName string = 'stai7uaegdeltuaen001'

@description('Dedicated storage account for permanent adverse-media PDF reports.')
param reportStorageName string = 'stai7uaereportsuaen001'

var deepResearchQueueName = 'adverse-media-deep-research'
var deepResearchDeadLetterQueueName = 'adverse-media-deep-research-deadletter'
var formsQueueName = 'forms-submissions'

resource deepResearchStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: deepResearchStorageName
}

resource deepResearchQueueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: deepResearchStorage
  name: 'default'
}

resource deepResearchDeadLetterQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: deepResearchQueueService
  name: deepResearchDeadLetterQueueName
}
// Cisco Talos ClamAV 1.4.6 LTS, mirrored into the private ACR and pinned to the amd64 manifest.
var bankStatementClamavImage = '${acrLoginServer}/ai7uae-clamav@sha256:6ba4e78b29853b2fc7e3c111389596e2cad5ec4ed5f0fd2cb663d29ab6b0e6a3'
var customDomains = concat(
  empty(apiCertificateId) ? [] : [
    {
      name: 'api.ai7uae.com'
      bindingType: 'SniEnabled'
      certificateId: apiCertificateId
    }
  ],
  empty(appCertificateId) ? [] : [
    {
      name: 'app.kycprobe.com'
      bindingType: 'SniEnabled'
      certificateId: appCertificateId
    }
  ]
)

resource merchantScreenshotWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-ai7uae-merchant-screenshot-uaen-001'
}

resource bankStatementWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: bankStatementWorkerIdentityName
}

resource bankStatementWorker 'Microsoft.App/containerApps@2025-07-01' = {
  name: bankStatementWorkerName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${bankStatementWorkerIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: acrLoginServer
          identity: bankStatementWorkerIdentity.id
        }
      ]
      secrets: [
        {
          name: 'bsa-data-key'
          keyVaultUrl: '${keyVaultUri}secrets/bsa-data-key'
          identity: bankStatementWorkerIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'bank-statement-worker'
          image: bankStatementWorkerImage
          env: [
            { name: 'BSA_AZURE_WORKER', value: '1' }
            { name: 'BSA_DATA_KEY_HEX', secretRef: 'bsa-data-key' }
            { name: 'BSA_STORAGE_BLOB_URL', value: 'https://${bankStatementStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'BSA_STORAGE_CONTAINER', value: 'bank-statement-analysis' }
            { name: 'BSA_STORAGE_QUEUE', value: 'bank-statement-analysis' }
            { name: 'BSA_STORAGE_TABLE', value: 'BankStatementAnalysis' }
            { name: 'BSA_WORKER_IDENTITY_CLIENT_ID', value: bankStatementWorkerIdentity.properties.clientId }
            { name: 'BSA_MANAGED_EXTRACTION_APPROVED', value: '1' }
            { name: 'BSA_AZURE_LAYOUT_ENDPOINT', value: bankStatementDocumentEndpoint }
            { name: 'BSA_AZURE_LAYOUT_REGION', value: location }
            { name: 'BSA_APPROVED_PROCESSING_REGION', value: location }
            { name: 'BSA_MANAGED_MAX_PAGES', value: '100' }
            { name: 'BSA_MANAGED_MAX_COST_USD', value: '1.00' }
            { name: 'BSA_MANAGED_ESTIMATED_PAGE_COST_USD', value: '0.01' }
            { name: 'BSA_CLAMD_HOST', value: '127.0.0.1' }
            { name: 'BSA_CLAMD_PORT', value: '3310' }
            { name: 'BSA_CLAMD_STARTUP_TIMEOUT_SECONDS', value: '180' }
            { name: 'BSA_WORKER_VISIBILITY_SECONDS', value: '900' }
            { name: 'BSA_PUBLIC_API_ORIGIN', value: 'https://api.ai7uae.com' }
            { name: 'BSA_CALLBACK_TIMEOUT_SECONDS', value: '20' }
            { name: 'BSA_CALLBACK_MAX_ATTEMPTS', value: '8' }
          ]
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
        }
        {
          name: 'clamav'
          image: bankStatementClamavImage
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'bank-statement-queue'
            azureQueue: {
              accountName: bankStatementStorageName
              queueName: 'bank-statement-analysis'
              queueLength: 1
              identity: bankStatementWorkerIdentity.id
            }
          }
        ]
      }
    }
  }
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
            { name: 'MERCHANT_SCREENSHOT_CHROMIUM_SANDBOX', value: 'false' }
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
      secrets: [
        {
          name: 'bsa-data-key'
          keyVaultUrl: '${keyVaultUri}secrets/bsa-data-key'
          identity: runtimeIdentityResourceId
        }
        {
          name: 'platform-smtp-password'
          keyVaultUrl: '${keyVaultUri}secrets/platform-smtp-password'
          identity: runtimeIdentityResourceId
        }
      ]
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
            { name: 'API_HOSTS', value: 'api.ai7uae.com,app.kycprobe.com' }
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: runtimeIdentityClientId }
            { name: 'ADVERSE_MEDIA_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${deepResearchQueueName}' }
            { name: 'ADVERSE_MEDIA_DEAD_LETTER_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${deepResearchDeadLetterQueueName}' }
            { name: 'ADVERSE_MEDIA_WORKER_ENABLED', value: enableDeepResearchWorker ? 'true' : 'false' }
            { name: 'FORMS_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${formsQueueName}' }
            { name: 'GDELT_STORAGE_ACCOUNT_URL', value: 'https://${gdeltStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'GDELT_ARCHIVE_CONTAINER', value: 'gdelt-archive' }
            { name: 'GDELT_INDEX_TABLE', value: 'GdeltEntityMentions' }
            { name: 'ADVERSE_MEDIA_REPORT_BLOB_URL', value: 'https://${reportStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE_URL', value: 'https://${reportStorageName}.table.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_CONTAINER', value: 'adverse-media-reports' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE', value: 'AdverseMediaReports' }
            { name: 'AZURE_REGION_DISPLAY', value: 'Microsoft Azure UAE North' }
            { name: 'API_PUBLIC_BASE_URL', value: 'https://api.ai7uae.com' }
            { name: 'APP_PUBLIC_BASE_URL', value: 'https://app.kycprobe.com' }
            { name: 'PLATFORM_SMTP_HOST', value: 'smtpout.secureserver.net' }
            { name: 'PLATFORM_SMTP_PORT', value: '465' }
            { name: 'PLATFORM_SMTP_USER', value: 'notify@kycprobe.com' }
            { name: 'PLATFORM_SMTP_PASSWORD', secretRef: 'platform-smtp-password' }
            { name: 'MERCHANT_SCREENSHOT_WORKER_URL', value: 'https://${merchantScreenshotWorker.properties.configuration.ingress.fqdn}' }
            { name: 'BSA_PRODUCTION_ENABLED', value: '1' }
            { name: 'BSA_DATA_KEY_HEX', secretRef: 'bsa-data-key' }
            { name: 'BSA_STORAGE_BLOB_URL', value: 'https://${bankStatementStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'BSA_STORAGE_CONTAINER', value: 'bank-statement-analysis' }
            { name: 'BSA_STORAGE_QUEUE', value: 'bank-statement-analysis' }
            { name: 'BSA_STORAGE_TABLE', value: 'BankStatementAnalysis' }
            { name: 'BSA_MAX_UPLOAD_BYTES', value: '26214400' }
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

resource apiLogWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource apiAlerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-ai7uae-api-uaen-001'
  location: 'global'
  properties: {
    enabled: true
    groupShortName: 'AI7UAEAPI'
    emailReceivers: [
      {
        name: 'KYCProbe operations'
        emailAddress: apiAlertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource apiFiveHundreds 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-ai7uae-api-sustained-5xx'
  location: 'global'
  properties: {
    description: 'Five or more API HTTP 5xx responses in five minutes.'
    severity: 2
    enabled: true
    scopes: [ api.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Api5xx'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'Requests'
          metricNamespace: 'Microsoft.App/containerApps'
          timeAggregation: 'Total'
          operator: 'GreaterThanOrEqual'
          threshold: 5
          dimensions: [
            {
              name: 'statuscodecategory'
              operator: 'Include'
              values: [ '5xx' ]
            }
          ]
        }
      ]
    }
    actions: [ { actionGroupId: apiAlerts.id } ]
  }
}

resource adverseSourceFailures 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-ai7uae-adverse-source-failures'
  location: location
  kind: 'LogAlert'
  properties: {
    description: 'Three or more adverse-media all-source failures in five minutes.'
    displayName: 'AI7 UAE adverse-media sources unavailable'
    severity: 2
    enabled: true
    scopes: [ apiLogWorkspace.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL | where ContainerAppName_s == "${containerAppName}" and Log_s has "adverse_media_search_unavailable" | summarize failed = count()'
          metricMeasureColumn: 'failed'
          timeAggregation: 'Total'
          operator: 'GreaterThanOrEqual'
          threshold: 3
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ apiAlerts.id ] }
  }
}

output fqdn string = api.properties.configuration.ingress.fqdn
output customDomainVerificationId string = api.properties.customDomainVerificationId
output latestRevisionName string = api.properties.latestRevisionName
output merchantScreenshotWorkerFqdn string = merchantScreenshotWorker.properties.configuration.ingress.fqdn
output merchantScreenshotWorkerLatestRevisionName string = merchantScreenshotWorker.properties.latestRevisionName
output bankStatementWorkerLatestRevisionName string = bankStatementWorker.properties.latestRevisionName
