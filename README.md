# AI7 UAE Vendor Verification

Public landing page and Azure deployment configuration for `ai7uae.com`.

The site is deployed as a static Nginx container in a dedicated UAE North resource group. Its Container Apps environment, registry, logging workspace, managed identities, and DNS zone are isolated from all KYCProbe and other project infrastructure. It contains no customer data and has no access to KYC application services or databases.

## Azure resources

- Resource group: `rg-ai7uae-web-uaen-001`
- Container Apps environment: `cae-ai7uae-web-uaen-001`
- Container app: `ca-ai7uae-web`
- Container registry: `acrai7uaeuaen001`
- Log Analytics workspace: `log-ai7uae-web-uaen-001`
- DNS zone: `ai7uae.com`

`infrastructure/platform.bicep` defines the dedicated platform. `infrastructure/main.bicep` deploys the digest-pinned site image, and `infrastructure/dns.bicep` preserves the domain's web and mail records.

The GitHub deployment identity receives the custom role in `infrastructure/ai7uae-deployer-role.json`. Its assignable scope is restricted to this project's resource group.
