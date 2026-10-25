targetScope = 'resourceGroup'

@description('UAE North region used by the AI7 UAE Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned API image reference.')
param image string

@description('Resource ID of the existing AI7 UAE Container Apps environment.')
param environmentId string

@description('Resource ID of the dedicated API runtime managed identity.')
param runtimeIdentityResourceId string

@description('Azure Container Registry login server.')
param acrLoginServer string

@secure()
@description('Versionless Key Vault URI for the upstream endpoint secret.')
param upstreamUrlSecretUri string

@secure()
@description('Versionless Key Vault URI for the upstream bearer-token secret.')
param upstreamTokenSecretUri string

@secure()
@description('Versionless Key Vault URI containing comma-separated SHA-256 client-key hashes.')
param clientKeyHashesSecretUri string

@description('Resource ID of the managed certificate for api.ai7uae.com. Leave blank until DNS validation is complete.')
param apiCertificateId string = ''

@description('Name of the API Container App.')
param containerAppName string = 'ca-ai7uae-api'

var customDomains = empty(apiCertificateId) ? [] : [
  {
    name: 'api.ai7uae.com'
    bindingType: 'SniEnabled'
    certificateId: apiCertificateId
  }
]

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
      secrets: [
        {
          name: 'upstream-url'
          keyVaultUrl: upstreamUrlSecretUri
          identity: runtimeIdentityResourceId
        }
        {
          name: 'upstream-token'
          keyVaultUrl: upstreamTokenSecretUri
          identity: runtimeIdentityResourceId
        }
        {
          name: 'client-key-hashes'
          keyVaultUrl: clientKeyHashesSecretUri
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
            { name: 'UAE_TLV_UPSTREAM_URL', secretRef: 'upstream-url' }
            { name: 'UAE_TLV_UPSTREAM_TOKEN', secretRef: 'upstream-token' }
            { name: 'AI7_API_KEY_HASHES', secretRef: 'client-key-hashes' }
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
      scale: { minReplicas: 0, maxReplicas: 3 }
    }
  }
}

output fqdn string = api.properties.configuration.ingress.fqdn
output customDomainVerificationId string = api.properties.customDomainVerificationId
output latestRevisionName string = api.properties.latestRevisionName
