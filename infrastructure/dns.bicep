targetScope = 'resourceGroup'

@description('The authoritative public DNS zone.')
param zoneName string = 'ai7uae.com'

@description('Static public IP of the UAE North Container Apps environment.')
param ingressIp string

@description('Generated FQDN of the AI7 UAE Container App.')
param generatedFqdn string

@secure()
@description('Container Apps custom-domain verification token. It is not a credential, but is handled as an operational value.')
param verificationId string

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
}

resource apexA 'Microsoft.Network/dnsZones/A@2018-05-01' = {
  parent: zone
  name: '@'
  properties: {
    TTL: 300
    ARecords: [
      { ipv4Address: ingressIp }
    ]
  }
}

resource wwwCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: zone
  name: 'www'
  properties: {
    TTL: 300
    CNAMERecord: { cname: generatedFqdn }
  }
}

resource emailCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: zone
  name: 'email'
  properties: {
    TTL: 300
    CNAMERecord: { cname: 'email.secureserver.net' }
  }
}

resource apexMx 'Microsoft.Network/dnsZones/MX@2018-05-01' = {
  parent: zone
  name: '@'
  properties: {
    TTL: 300
    MXRecords: [
      { preference: 0, exchange: 'smtp.secureserver.net' }
      { preference: 1, exchange: 'smtp.google.com' }
      { preference: 10, exchange: 'mailstore1.secureserver.net' }
    ]
  }
}

resource apexTxt 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: '@'
  properties: {
    TTL: 300
    TXTRecords: [
      { value: [ 'T3400864' ] }
      { value: [ 'google-site-verification=AcklaD2lyOksljuEjcceLEt3XH4B4Fe6-arWdsCpasc' ] }
      { value: [ 'v=spf1 include:secureserver.net -all' ] }
    ]
  }
}

resource apexValidation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: 'asuid'
  properties: {
    TTL: 300
    TXTRecords: [ { value: [ verificationId ] } ]
  }
}

resource wwwValidation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: 'asuid.www'
  properties: {
    TTL: 300
    TXTRecords: [ { value: [ verificationId ] } ]
  }
}

resource dmarc 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: '_dmarc'
  properties: {
    TTL: 300
    TXTRecords: [
      { value: [ 'v=DMARC1; p=reject; rua=mailto:dmarc_rua@onsecureserver.net; adkim=r; aspf=r;' ] }
    ]
  }
}

resource googleDkim 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: 'google._domainkey'
  properties: {
    TTL: 300
    TXTRecords: [
      {
        value: [
          'v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw1JmQf4SzB8E9UIBoBWh9rK8lGhV0QTAf5SbFralRBPIIkMaGi4Ym34U7crWT5Ny6GzR0uGhJcJP8cWNqWPPZjuWzNzvWUQtcibCHk+RzDKgRM55d0CXWDkw/CI6rccs9FuybBksyxfUbKzz1DLw9mLccbovBLPtCerpqMSUhJ5ufwPWLgB36oMaQfVBNEx1udl'
          '0FYqCITbrB99Ht3y3xdCqqeLkHMqMdU8nAhummJIFLdxjWk0qyacgeM/Mu3X3anbQD2UpWyFYvoy+1jYZ842HY/HCDwON6SVOpZUUnhvUEhcMJa13KNGL9Qeu5nDCq8AStP8CstGemmnmawi2oQIDAQAB'
        ]
      }
    ]
  }
}

resource caa 'Microsoft.Network/dnsZones/CAA@2018-05-01' = {
  parent: zone
  name: '@'
  properties: {
    TTL: 300
    caaRecords: [
      { flags: 0, tag: 'issue', value: 'letsencrypt.org' }
      { flags: 0, tag: 'issue', value: 'pki.goog' }
      { flags: 0, tag: 'issue', value: 'sectigo.com' }
      { flags: 0, tag: 'issue', value: 'digicert.com' }
    ]
  }
}

resource autodiscover 'Microsoft.Network/dnsZones/SRV@2018-05-01' = {
  parent: zone
  name: '@'
  properties: {
    TTL: 300
    SRVRecords: [
      {
        priority: 100
        weight: 1
        port: 443
        target: 'autodiscover.secureserver.net'
      }
    ]
  }
}

output authoritativeNameservers array = zone.properties.nameServers
