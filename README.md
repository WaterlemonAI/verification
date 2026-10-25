# AI7 UAE Vendor Verification and API

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

## Verification API

The provider-neutral API portal and wrapper are served from `api.ai7uae.com`. The first endpoint is:

```text
POST /service/uae_tlv
```

It accepts `application/json` and `multipart/form-data`, authenticates each AI7 customer with a Bearer API key, and relays the upstream JSON body and HTTP status without exposing upstream hostnames, credentials, or identifying headers. The portal includes copyable cURL, JavaScript, and Python examples, an OpenAPI document, and a live JSON response console.

Client keys are stored only as SHA-256 hashes. Upstream configuration and hashes are loaded from Azure Key Vault through the API app's dedicated managed identity. No provider secrets are committed to this repository or sent to the browser.

Run the contract tests locally with:

```bash
npm test
```

Run the API container with the values described in `.env.example`:

```bash
docker build -f Dockerfile.api -t ai7uae-api:local .
docker run --rm -p 8080:8080 --env-file .env ai7uae-api:local
```

API-specific Azure definitions are intentionally separate from the existing landing app:

- `infrastructure/api-platform.bicep` creates dedicated API runtime/deployment identities, workload federation, and Key Vault.
- `infrastructure/api.bicep` creates `ca-ai7uae-api` and reads its three secrets through managed identity.
- `infrastructure/api-dns.bicep` adds only the `api` and `asuid.api` records to the existing AI7 UAE DNS zone.
- `.github/workflows/deploy-api.yml` builds and deploys a digest-pinned API image through the protected `ai7uae-api` GitHub environment.

The API app expects these versionless Key Vault secrets:

- `uae-tlv-upstream-url`: the private upstream endpoint.
- `uae-tlv-upstream-token`: the private upstream Bearer token.
- `ai7-client-key-hashes`: comma-separated SHA-256 hashes of active AI7 customer API keys.

Do not commit or place plaintext credentials in GitHub variables. Create and rotate them in the dedicated API vault, then keep only each customer's hash in `ai7-client-key-hashes`.
