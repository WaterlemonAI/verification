targetScope = 'resourceGroup'

@description('Existing VNet-integrated KYCProbe Container Apps environment name.')
param privateEnvironmentName string = 'cae-ai7uae-private-uaen-001'

@description('Approved KYCProbe UAE North location.')
param location string = 'uaenorth'

resource privateEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: privateEnvironmentName
}

resource apiCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2026-07-01' = {
  parent: privateEnvironment
  name: 'mc-cae-ai7uae-api-vnet-001'
  location: location
  properties: {
    subjectName: 'api.ai7uae.com'
    domainControlValidation: 'TXT'
  }
}

resource appCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2026-07-01' = {
  parent: privateEnvironment
  name: 'mc-cae-ai7uae-app-vnet-001'
  location: location
  properties: {
    subjectName: 'app.kycprobe.com'
    domainControlValidation: 'TXT'
  }
}

output apiCertificateId string = apiCertificate.id
output appCertificateId string = appCertificate.id
