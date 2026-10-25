# `ai7uae.com` DNS migration

The authoritative zone is hosted in Azure DNS. The registrar is GoDaddy.

## Cutover controls

1. Recreate the currently observed Vercel-hosted zone records in Azure DNS.
2. Add the Container Apps apex, `www`, and domain-verification records.
3. Query each assigned Azure nameserver directly before changing delegation.
4. Replace the Vercel nameservers at GoDaddy only after the Azure zone is complete.
5. Verify delegation, mail records, HTTP, TLS, and the deployed revision after propagation.

Do not remove the mail, SPF, DKIM, DMARC, Google verification, CAA, or autodiscover records during the migration.

`infrastructure/dns.bicep` is the source definition for the migrated zone. The authoritative zone is deployed inside `rg-ai7uae-web-uaen-001`; no shared KYCProbe or other-project DNS resource is used. Registrar delegation and managed-certificate validation are observed during cutover before the retired AI7-specific staging resources are removed.
