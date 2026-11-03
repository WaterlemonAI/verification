# Peppol global search

`POST /service/peppol_check` is a separate KYCProbe API. It accepts a published
organization name and optional ISO 3166-1 alpha-2 `country` code. `AE` is the
United Arab Emirates. `GET /service/peppol_check/countries` lists countries in
the loaded snapshot. The KYCProbe admin Peppol check page provides the same
search with an optional country dropdown.

```json
{"name":"Etihad Airways Engineering","country":"AE"}
```

The API uses an Azure Table index built from the complete 2026-11-03 Peppol
Directory export (9,440,021 business cards). It makes no live request to
Peppol. A normalized exact name is hashed into one of 256 partitions. Within
that partition, row keys group matches by country. Supplying `country` narrows
the indexed row-key range before data is read; omitting it searches matches
from all countries. Matching ignores case and punctuation. The result returns
published participant IDs, document types, business-card details, source
snapshot time, stale flag, and a name-match or no-result status. It returns at
most 10 matches and indicates truncation.

This is an exact normalized-name lookup. A `not_found` result is not proof that
the organization is absent from the Peppol network. Directory publication is
optional, and a name match is not legal identity verification.

The UAE Trade Licence Verification and Trade License OCR Peppol options pass
`country: AE` explicitly and continue to use the small private UAE index. They
never scan the global table.

## Storage and ingest

The private `PeppolDirectoryNames` table is defined in
`infrastructure/api-document-ocr-platform.bicep`. The API runtime identity
already has Table data access to the dedicated storage account. The table
holds compressed business-card records. The `meta/current` row is written only
after the full export has been processed and validated, so the API returns
`unavailable` while the first global index is incomplete. Import progress is
checkpointed; rerunning an interrupted import upserts the same deterministic
keys. New export timestamps use a new partition version, which becomes active
when `meta/current` changes.

To ingest locally with an Azure CLI login that has Table Data Contributor on
this table:

```sh
node scripts/ingest-peppol-global.mjs /path/to/export-all-businesscards.xml
```

The manual Azure Container Apps job `caj-ai7uae-peppol-ingest` uses
`Dockerfile.peppol-ingest`, downloads the private compressed source archive,
and runs the same importer near the storage account. Set
`PEPPOL_SOURCE_BLOB_URL`, `PEPPOL_GLOBAL_TABLE_URL`, and
`RUNTIME_IDENTITY_CLIENT_ID` as in `infrastructure/api.bicep`, then start the
job. The cloud job stores its progress in the table. The job must complete
before enabling customer traffic to the global API. Older version partitions
should be removed after the new version has been validated.

The public request requires a KYCProbe API key and the `peppol-directory`
module. The admin page requires an administrator session. No Peppol API key
is required.
