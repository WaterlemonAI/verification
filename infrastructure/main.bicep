targetScope = 'resourceGroup'

@description('UAE North region used by the existing Container Apps environment.')
param location string = 'uaenorth'

@description('Digest-pinned ACR image reference.')
param image string

@description('Resource ID of the existing Container Apps managed environment.')
param environmentId string

@description('Resource ID of the dedicated AI7 UAE runtime managed identity.')
param runtimeIdentityResourceId string

@description('Azure Container Registry login server.')
param acrLoginServer string

@description('Resource ID of the managed certificate for ai7uae.com.')
param apexCertificateId string

@description('Resource ID of the managed certificate for www.ai7uae.com.')
param wwwCertificateId string

@description('Name of the landing-page Container App.')
param containerAppName string = 'ca-ai7uae-staging-web'

resource web 'Microsoft.App/containerApps@2024-03-01' = {
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
        customDomains: [
          {
            name: 'ai7uae.com'
            bindingType: 'SniEnabled'
            certificateId: apexCertificateId
          }
          {
            name: 'www.ai7uae.com'
            bindingType: 'SniEnabled'
            certificateId: wwwCertificateId
          }
        ]
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
          name: 'web'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 30
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 2
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

output fqdn string = web.properties.configuration.ingress.fqdn
output latestRevisionName string = web.properties.latestRevisionName
