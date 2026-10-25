targetScope = 'resourceGroup'

@description('Azure region for AI7 UAE.')
param location string = 'uaenorth'

@description('Name of the dedicated API runtime managed identity.')
param runtimeIdentityName string = 'id-ai7uae-api-runtime'

@description('Name of the dedicated API deployment managed identity.')
param deployerIdentityName string = 'id-ai7uae-api-deployer'

@description('GitHub Actions federated identity subject for the protected API deployment environment.')
param githubSubject string

@description('Globally unique Key Vault name.')
param keyVaultName string

@description('Optional administrator object ID allowed to manage secrets in this API-only vault.')
param vaultAdministratorObjectId string = ''

@description('Resource ID of the existing AI7 UAE container registry.')
param registryId string

var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var acrPushRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
var keyVaultSecretsOfficerRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var ai7DeployerRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '49bb2024-1835-4b1b-a28f-818ee6f5f889')

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
  name: 'github-verification-ai7uae-api'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: githubSubject
    audiences: [ 'api://AzureADTokenExchange' ]
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    sku: { family: 'A', name: 'standard' }
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

resource runtimeCanReadSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, runtimeIdentity.id, keyVaultSecretsOfficerRoleDefinitionId)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficerRoleDefinitionId
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource administratorCanManageSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(vaultAdministratorObjectId)) {
  name: guid(vault.id, vaultAdministratorObjectId, keyVaultSecretsOfficerRoleDefinitionId)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficerRoleDefinitionId
    principalId: vaultAdministratorObjectId
    principalType: 'User'
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

resource deployerCanDeploy 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployerIdentity.id, ai7DeployerRoleDefinitionId)
  properties: {
    roleDefinitionId: ai7DeployerRoleDefinitionId
    principalId: deployerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output runtimeIdentityResourceId string = runtimeIdentity.id
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
output deployerClientId string = deployerIdentity.properties.clientId
output deployerPrincipalId string = deployerIdentity.properties.principalId
output keyVaultId string = vault.id
output keyVaultUri string = vault.properties.vaultUri
