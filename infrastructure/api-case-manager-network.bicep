targetScope = 'resourceGroup'

@description('KYCProbe UAE North only. This template creates a new environment; it never updates the live Container Apps environment.')
param location string = 'uaenorth'

@description('New KYCProbe-only virtual network name.')
param vnetName string = 'vnet-ai7uae-cases-uaen-001'

@description('New KYCProbe-only Container Apps environment name.')
param environmentName string = 'cae-ai7uae-private-uaen-001'

@description('Reviewed, non-overlapping VNet CIDR. Keep the delegated and private-endpoint subnets inside this range.')
param vnetPrefix string = '10.244.0.0/20'

@description('Dedicated Container Apps infrastructure subnet; /23 leaves room for parallel revisions and workers.')
param infrastructureSubnetPrefix string = '10.244.0.0/23'

@description('Dedicated subnet for Case Manager Blob, Table and Queue private endpoints.')
param privateEndpointSubnetPrefix string = '10.244.2.0/27'

@description('Existing KYCProbe-only Log Analytics workspace; no workspace update is intended.')
param logAnalyticsWorkspaceName string = 'log-ai7uae-web-uaen-001'

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: [vnetPrefix] }
    subnets: [
      {
        name: 'snet-container-apps'
        properties: {
          addressPrefix: infrastructureSubnetPrefix
          delegations: [
            { name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'snet-container-apps')
      internal: false
    }
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: logWorkspace.listKeys().primarySharedKey
      }
    }
  }
  dependsOn: [vnet]
}

var storageZones = [
  'privatelink.blob.${az.environment().suffixes.storage}'
  'privatelink.table.${az.environment().suffixes.storage}'
  'privatelink.queue.${az.environment().suffixes.storage}'
]

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in storageZones: {
  name: zone
  location: 'global'
}]

resource privateDnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, index) in storageZones: {
  parent: privateDnsZones[index]
  name: 'link-ai7uae-cases-uaen-001'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

output environmentId string = environment.id
output environmentDefaultDomain string = environment.properties.defaultDomain
output vnetId string = vnet.id
output privateEndpointSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'snet-private-endpoints')
output privateDnsZoneIds array = [for (zone, index) in storageZones: privateDnsZones[index].id]
