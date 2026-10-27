targetScope = 'resourceGroup'

@description('UAE North region used by the AI7 UAE Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned API image reference.')
param image string

@description('Digest-pinned isolated merchant screenshot worker image reference.')
param merchantScreenshotWorkerImage string

@description('Digest-pinned bank statement analysis worker image reference.')
param bankStatementWorkerImage string

@description('Digest-pinned document OCR worker image. Required only when document OCR is enabled.')
param documentOcrWorkerImage string = ''

@description('Enable the eight document OCR APIs only after all sample and credential validation gates pass.')
param enableDocumentOcr bool = false

@description('Start the isolated document OCR worker before customer routes are enabled for queue and malware-gate smoke tests.')
param enableDocumentOcrWorker bool = false

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

@description('Dedicated document OCR storage account; never reuse the bank statement store.')
param documentOcrStorageName string = 'stai7uaeocruaen001'

@description('Dedicated S0 Document Intelligence account for the eight extraction APIs.')
param documentOcrEndpoint string = 'https://doc-ai7uae-ocr-uaen-001.cognitiveservices.azure.com/'

@description('Dedicated document OCR worker identity name.')
param documentOcrWorkerIdentityName string = 'id-ai7uae-ocr-worker-uaen-001'

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

@description('Dedicated private storage account for 365-day adverse-media request/response JSON.')
param adverseJsonStorageName string = 'stai7uaejsonuaen001'

var deepResearchQueueName = 'adverse-media-deep-research'
var deepResearchDeadLetterQueueName = 'adverse-media-deep-research-deadletter'
var formsQueueName = 'forms-submissions'
var formsDeadLetterQueueName = 'forms-submissions-deadletter'

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

resource formsDeadLetterQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: deepResearchQueueService
  name: formsDeadLetterQueueName
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

resource documentOcrWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: documentOcrWorkerIdentityName
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

resource documentOcrWorker 'Microsoft.App/containerApps@2025-07-01' = if (enableDocumentOcr || enableDocumentOcrWorker) {
  name: 'ca-ai7uae-document-ocr-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${documentOcrWorkerIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [ { server: acrLoginServer, identity: documentOcrWorkerIdentity.id } ]
      secrets: [
        { name: 'ocr-data-key', keyVaultUrl: '${keyVaultUri}secrets/document-ocr-data-key', identity: documentOcrWorkerIdentity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'document-ocr-worker'
          image: documentOcrWorkerImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: documentOcrWorkerIdentity.properties.clientId }
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE_URL', value: 'https://${reportStorageName}.table.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE', value: 'AdverseMediaReports' }
            { name: 'DOCUMENT_OCR_STORAGE_BLOB_URL', value: 'https://${documentOcrStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'DOCUMENT_OCR_DATA_KEY_HEX', secretRef: 'ocr-data-key' }
            { name: 'DOCUMENT_OCR_AZURE_ENDPOINT', value: documentOcrEndpoint }
            { name: 'DOCUMENT_OCR_AZURE_REGION', value: location }
            { name: 'DOCUMENT_OCR_APPROVED_REGION', value: location }
            { name: 'DOCUMENT_OCR_CLAMD_HOST', value: '127.0.0.1' }
            { name: 'DOCUMENT_OCR_CLAMD_PORT', value: '3310' }
            { name: 'DOCUMENT_OCR_WORKER_IMAGE', value: documentOcrWorkerImage }
          ]
          resources: { cpu: json('2.0'), memory: '4Gi' }
        }
        {
          name: 'clamav'
          image: bankStatementClamavImage
          resources: { cpu: json('2.0'), memory: '4Gi' }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'document-ocr-queue'
            azureQueue: {
              accountName: documentOcrStorageName
              queueName: 'document-ocr-jobs'
              queueLength: 1
              identity: documentOcrWorkerIdentity.id
            }
          }
        ]
      }
    }
  }
}

resource documentOcrPurgeJob 'Microsoft.App/jobs@2024-03-01' = if (enableDocumentOcr || enableDocumentOcrWorker) {
  name: 'caj-ai7uae-document-ocr-purge'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${documentOcrWorkerIdentity.id}': {} }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 3600
      replicaRetryLimit: 2
      scheduleTriggerConfig: { cronExpression: '15 * * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [ { server: acrLoginServer, identity: documentOcrWorkerIdentity.id } ]
    }
    template: {
      containers: [
        {
          name: 'document-ocr-purge'
          image: documentOcrWorkerImage
          command: [ 'node', 'scripts/purge-document-ocr.mjs' ]
          env: [
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: documentOcrWorkerIdentity.properties.clientId }
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
      secrets: concat([
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
      ], enableDocumentOcr ? [
        { name: 'ocr-data-key', keyVaultUrl: '${keyVaultUri}secrets/document-ocr-data-key', identity: runtimeIdentityResourceId }
        { name: 'ocr-download-key', keyVaultUrl: '${keyVaultUri}secrets/document-ocr-download-key', identity: runtimeIdentityResourceId }
      ] : [])
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
          env: concat([
            { name: 'API_HOSTS', value: 'api.ai7uae.com,app.kycprobe.com' }
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'RUNTIME_IDENTITY_CLIENT_ID', value: runtimeIdentityClientId }
            { name: 'ADVERSE_MEDIA_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${deepResearchQueueName}' }
            { name: 'ADVERSE_MEDIA_DEAD_LETTER_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${deepResearchDeadLetterQueueName}' }
            { name: 'ADVERSE_MEDIA_WORKER_ENABLED', value: enableDeepResearchWorker ? 'true' : 'false' }
            { name: 'FORMS_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${formsQueueName}' }
            { name: 'FORMS_DEAD_LETTER_QUEUE_URL', value: 'https://${deepResearchStorageName}.queue.${environment().suffixes.storage}/${formsDeadLetterQueueName}' }
            { name: 'GDELT_STORAGE_ACCOUNT_URL', value: 'https://${gdeltStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'GDELT_ARCHIVE_CONTAINER', value: 'gdelt-archive' }
            { name: 'GDELT_INDEX_TABLE', value: 'GdeltEntityMentions' }
            { name: 'ADVERSE_MEDIA_REPORT_BLOB_URL', value: 'https://${reportStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE_URL', value: 'https://${reportStorageName}.table.${environment().suffixes.storage}' }
            { name: 'ADVERSE_MEDIA_REPORT_CONTAINER', value: 'adverse-media-reports' }
            { name: 'ADVERSE_MEDIA_REPORT_TABLE', value: 'AdverseMediaReports' }
            { name: 'ADVERSE_MEDIA_JSON_BLOB_URL', value: 'https://${adverseJsonStorageName}.blob.${environment().suffixes.storage}' }
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
            { name: 'DOCUMENT_OCR_PRODUCTION_ENABLED', value: enableDocumentOcr ? '1' : '0' }
          ], enableDocumentOcr ? [
            { name: 'DOCUMENT_OCR_STORAGE_BLOB_URL', value: 'https://${documentOcrStorageName}.blob.${environment().suffixes.storage}' }
            { name: 'DOCUMENT_OCR_DATA_KEY_HEX', secretRef: 'ocr-data-key' }
            { name: 'DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX', secretRef: 'ocr-download-key' }
            { name: 'DOCUMENT_OCR_WORKER_IMAGE', value: documentOcrWorkerImage }
          ] : [])
          resources: {
            cpu: json(enableDocumentOcr ? '0.5' : '0.25')
            memory: enableDocumentOcr ? '1Gi' : '0.5Gi'
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
      scale: {
        minReplicas: 1
        maxReplicas: 8
        rules: [
          {
            name: 'api-http-concurrency'
            http: { metadata: { concurrentRequests: '16' } }
          }
        ]
      }
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
              name: 'statusCodeCategory'
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
