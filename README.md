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

The provider-neutral API portal and wrapper are served from `api.ai7uae.com`. Current endpoints are:

```text
POST /service/uae_tlv
POST /service/iban_verification
POST /service/entity_search
POST /service/adverse_media
```

The services authenticate each AI7 customer with one Bearer API key. Provider-backed wrappers relay their upstream JSON body and HTTP status without exposing upstream hostnames, credentials, or identifying headers. The native adverse-media service searches global news and open-web indexes in up to five languages, deduplicates evidence, classifies adverse-event categories and legal stage, and enforces a 12-query/$0.12 internal cost guardrail. The portal includes copyable cURL, JavaScript, and Python examples, an OpenAPI document, and live JSON response consoles. The comprehensive entity-search page also exposes a searchable response-field reference generated from every path in its official schema and response variants.

Client keys are stored only as SHA-256 hashes. Upstream configuration and hashes are loaded from Azure Key Vault through the API app's dedicated managed identity. No provider secrets are committed to this repository or sent to the browser.

### API Engine administration

The protected console at `/admin` lets an operator:

- register a provider-neutral public route and private upstream endpoint;
- store or rotate a write-only upstream master authentication key;
- configure Bearer, custom-header, or unauthenticated upstream access;
- constrain accepted content types and document expected status codes;
- enable or disable an integration;
- issue a one-time customer API key that works across every configured integration; and
- revoke a customer key without changing other customers or upstream credentials.

The admin key stays in browser memory only. Issued customer keys are displayed once, while only SHA-256 hashes are retained. Public catalog responses omit upstream URLs, authentication configuration, Key Vault names, and supplier identity.

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
- `infrastructure/api.bicep` creates `ca-ai7uae-api` and gives the engine its managed-identity Key Vault connection.
- `infrastructure/api-dns.bicep` adds only the `api` and `asuid.api` records to the existing AI7 UAE DNS zone.
- `.github/workflows/deploy-api.yml` builds and deploys a digest-pinned API image through the protected `ai7uae-api` GitHub environment.

The API Engine manages these records inside the dedicated Key Vault:

- `ai7-admin-key-hashes`: comma-separated SHA-256 hashes of authorized admin keys; bootstrapped outside the app.
- `api-engine-integrations`: the private integration registry.
- `client-<id>`: one customer record per key, containing only the hash plus non-secret lifecycle tags.
- `integration-<id>-master-key`: one write-only upstream master key per integration.

`adverse-media` is a runtime-managed integration. Its private search credential is stored as `integration-adverse-media-master-key` and can be set or rotated from the same protected administration console.

Do not commit or place plaintext credentials in GitHub variables. Bootstrap the admin hash in the dedicated API vault, then manage integrations and customer credentials through the protected console.
