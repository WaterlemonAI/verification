targetScope = 'resourceGroup'

@description('The existing authoritative public DNS zone.')
param zoneName string = 'ai7uae.com'

@description('Generated FQDN of the AI7 UAE API Container App.')
param apiGeneratedFqdn string

@secure()
@description('Container Apps custom-domain verification token for the API app.')
param apiVerificationId string

resource zone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: zoneName
}

resource apiCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: zone
  name: 'api'
  properties: {
    TTL: 300
    CNAMERecord: { cname: apiGeneratedFqdn }
  }
}

resource apiValidation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: 'asuid.api'
  properties: {
    TTL: 300
    TXTRecords: [ { value: [ apiVerificationId ] } ]
  }
}
