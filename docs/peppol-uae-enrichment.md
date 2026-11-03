# UAE Peppol enrichment

The UAE Trade Licence Verification and UAE Trade License OCR APIs accept the optional
`X-AI7-Peppol-Check: true` header. Their portal testers expose it as a checkbox.
The default request and response contracts stay unchanged when the option is off.

When selected, the licence verification API uses the name returned in
`uae_tl_verification.licence_registration_name` (or the compatibility result and
Arabic fallback). The OCR worker uses `data.company_name_english`, falling back
to `data.company_name_arabic`. Each adds a separate `peppol` object to its
successful result. Failed or missing lookups do not change the original
verification or extraction outcome.

The lookup searches an **in-memory UAE-only index** built from the official
Peppol Directory business-card export. Requests never call the public Directory
API or send the customer name to Peppol. The index supplies participant IDs,
published receiving document types, names, country, and any published identifiers,
websites, contacts, address text, extra information and registration date. The
response includes `snapshot_at`, `stale` (older than 48 hours), and a match status:

- `name_match`: a published name matches after case and punctuation normalization.
- `possible_matches`: similar UAE names, requiring human review.
- `not_found`: no name candidate in this UAE snapshot. This does not establish
  that the organization is absent from the Peppol network.
- `name_unavailable`: no usable company name was extracted.
- `unavailable`: the local index could not be loaded.

## Build from the downloaded XML export

```sh
python3 scripts/build-peppol-uae-index.py \
  /path/to/export-all-businesscards.xml \
  .local-peppol/uae-index.jsonl
```

The converter accepts XML or `.xml.gz`, streams it, and writes a compact JSONL file atomically. It
retains only business cards with a UAE (`AE`) entity. A header records the export
creation timestamp and a footer records the number of cards; the runtime rejects
an incomplete index. The generated file is excluded from Git because it contains
source-supplied contact details. For local use, set `PEPPOL_INDEX_PATH` to its
absolute path in the API process **and** the OCR worker process.

The initial index built from the 2026-11-03 export contains 35,133 UAE business
cards and is 41,699,371 bytes. Its source snapshot timestamp is
`2026-11-03T02:02:45.637276099Z`. The complete XML export is 19,302,922,851
bytes before compression and 918,516,988 bytes as gzip. It is archived
separately so later features can index other countries.

## Private production index

`infrastructure/api-document-ocr-platform.bicep` defines private
`peppol-directory-index` and `peppol-directory-source` containers in the existing dedicated OCR storage
account. Both the API and OCR worker identities already receive Blob data access
to that account. `infrastructure/api.bicep` sets `PEPPOL_INDEX_BLOB_URL` to the
`uae-index.jsonl` blob for both runtimes. The runtimes stream the blob into memory
on first use, then search without network calls. Every five minutes they check
for a newer ETag and replace the index after a complete, valid load.

After reviewing the built index and deploying the container definition, upload
it with an account authorized for Blob data writes. Archive the complete XML
as gzip in the source container for later global features:

```sh
az storage blob upload --auth-mode login \
  --account-name stai7uaeocruaen001 \
  --container-name peppol-directory-index \
  --name uae-index.jsonl \
  --file .local-peppol/uae-index.jsonl \
  --overwrite true

gzip -1 -c /path/to/export-all-businesscards.xml > .local-peppol/export-all-businesscards-2026-11-03.xml.gz

az storage blob upload --auth-mode login \
  --account-name stai7uaeocruaen001 \
  --container-name peppol-directory-source \
  --name export-all-businesscards-2026-11-03.xml.gz \
  --file .local-peppol/export-all-businesscards-2026-11-03.xml.gz \
  --content-type application/gzip \
  --overwrite true
```

The [official export](https://directory.peppol.eu/public/locale-en_US/menuitem-docs-export-all)
is refreshed daily. Build and upload a new index after each daily export, and
monitor `snapshot_at` and `stale` in responses. Source information is supplied
by SMP providers; [Directory publication is optional](https://peppol.org/tools-support/peppol-directory/).
Name matches are supporting evidence, not proof of legal identity or current
delivery capability.
