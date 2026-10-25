targetScope = 'resourceGroup'

@description('Azure region for the dedicated AI7 UAE platform.')
param location string = 'uaenorth'

@description('GitHub Actions federated identity subject for the protected deployment environment.')
param githubSubject string

@description('Log Analytics workspace name.')
param logAnalyticsName string = 'log-ai7uae-web-uaen-001'

@description('Azure Container Registry name. Must be globally unique.')
param acrName string = 'acrai7uaeuaen001'

@description('Container Apps managed environment name.')
param environmentName string = 'cae-ai7uae-web-uaen-001'

@description('Runtime identity used only by the AI7 UAE web application.')
param runtimeIdentityName string = 'id-ai7uae-runtime'

@description('Deployment identity used only by the AI7 UAE GitHub environment.')
param deployerIdentityName string = 'id-ai7uae-deployer'

var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var acrPushRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    dataEndpointEnabled: false
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: runtimeIdentityName
  location: location
}

resource deployerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: deployerIdentityName
  location: location
}

resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployerIdentity
  name: 'github-verification-ai7uae'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: githubSubject
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource runtimeCanPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtimeIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerCanPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployerIdentity.id, acrPushRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: acrPushRoleDefinitionId
    principalId: deployerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output acrName string = registry.name
output acrLoginServer string = registry.properties.loginServer
output environmentId string = environment.id
output environmentStaticIp string = environment.properties.staticIp
output runtimeIdentityResourceId string = runtimeIdentity.id
output deployerClientId string = deployerIdentity.properties.clientId
output deployerPrincipalId string = deployerIdentity.properties.principalId
output logAnalyticsWorkspaceId string = logs.id
