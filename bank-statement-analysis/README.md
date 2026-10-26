# Bank Statement Analysis local demo

This is a runnable local implementation of the [MVP handoff](../docs/bank-statement-analysis/README.md). It accepts a PDF or ordered image bundle through the existing Bearer-key API or signed admin session, queues encrypted payloads in a private local directory, and processes them asynchronously in a separate Python worker. The module is inside `http://127.0.0.1:8080/admin` under **Analysis**, alongside Forms. There is no standalone browser page. The [requirements tracker](REQUIREMENTS.md) identifies what is complete locally and what remains open.

## Run with Docker

Create distinct local customer and admin keys and put their SHA-256 hex digests in the environment. The following sample keys are for local loopback testing only:

```bash
export AI7_API_KEY_HASHES="$(printf %s ai7_bsa_local_demo_2026 | shasum -a 256 | cut -d ' ' -f 1)"
export AI7_ADMIN_KEY_HASHES="$(printf %s ai7_bsa_admin_demo_2026 | shasum -a 256 | cut -d ' ' -f 1)"
export BSA_DATA_KEY_HEX="$(openssl rand -hex 32)"
docker compose -f compose.bsa-demo.yml up --build
```

Open `/admin`. On first use, enter `ai7_bsa_admin_demo_2026` as the one-time setup key and create an administrator email and password. Then choose **Analysis**. The bank statement module uses the signed admin session for upload and result routes. The customer-facing API uses `ai7_bsa_local_demo_2026`. Docker binds the API to `127.0.0.1` and keeps job files in a private named volume. Preserve `BSA_DATA_KEY_HEX` securely across restarts to read prior jobs. Stop with `docker compose -f compose.bsa-demo.yml down`. No automatic lifecycle deletion is configured while retention policy remains open.

## Run without Docker

Use Node 22 or newer and Python 3.12 or newer. Install Node dependencies with `npm ci`; install the Python package with `python3 -m pip install -e './bank-statement-analysis[test]'`. Set the **same** `BSA_DATA_KEY_HEX` in both process environments and preserve it securely for later reads. From the repository root, start the two processes in separate terminals:

```bash
BSA_DATA_DIR=.local-bsa python3 -m bsa.worker --watch
```

Set `PYTHONPATH=bank-statement-analysis/src` if the package is not installed. For the API:

```bash
BSA_LOCAL_ENABLED=1 BSA_DATA_DIR=.local-bsa BIND_HOST=127.0.0.1 AI7_API_KEY_HASHES="$AI7_API_KEY_HASHES" AI7_ADMIN_KEY_HASHES="$AI7_ADMIN_KEY_HASHES" npm start
```

Generate the fictional test fixture again with `python3 bank-statement-analysis/scripts/create_demo_fixture.py`. The fixture is stored at `test/fixtures/bsa-synthetic-combined.pdf` and is not served by the admin app. The gated local OpenAPI document is at `/bank-statement-analysis/openapi.json`; the live `/openapi.json` does not advertise this undeployed service.

## Supported in this slice

- Direct PDF or ordered PNG/JPEG/TIFF image-bundle upload, MIME/magic-byte and size checks, idempotency, authenticated tenant-scoped status, result, and artifact retrieval. The existing admin console uses its signed session and isolated analysis scope.
- Asynchronous local file queue and separate timeout-bounded Python parser process. Managed Azure calls occur only when the approved Azure Layout configuration is present; the default setup stays private and local. Raw inputs, declared fields, results, and exports for new jobs use AES-256-GCM encryption at rest.
- Native text extraction of the documented AI7 synthetic statement layout, including combined PDFs with multiple banks, accounts, periods, products, owners, and currencies. Mixed synthetic and ADCB pages and two ADCB accounts in one PDF are segmented independently.
- Bank-neutral table inference discovers date, description, debit/credit or amount, and running-balance columns in drawn or borderless native PDFs and legible scanned PDFs through private OCR. It tests candidate mappings against exact row and closing balances, splits pages with distinct account/period evidence, and keeps ownership unknown until independently corroborated. A bank profile is not required for this path.
- A bounded OCR adapter for Banque Misr's scanned historical-statement layout (up to ten pages), and a native-table adapter for ADCB's seven-column account-statement layout. Both retain source-page and row evidence and require exact running-balance reconciliation.
- Exact `Decimal` monetary values, row and statement reconciliation, explicit partial state, overlap deduplication, tenant-scoped account fingerprints, and per-account/currency coverage.
- Source page, bounding polygon, and raw-row evidence for recognized layouts; versioned bank profiles, schema, rule, and formula manifest.
- The worker compares native text against a private OCR read of rendered PDF pages. Pages with a material mismatch are treated as untrusted and re-extracted through the Layout or OCR path, with a partial review result.
- An Azure Document Intelligence v4 `prebuilt-layout` adapter and provider-neutral table bridge are implemented and tested using local simulated responses. Submission, polling, same-origin result-URL validation, result deletion, region/page/cost gates, and reconciliation from Layout cells are covered. The worker receives Azure settings from `compose.bsa-demo.yml`; the admin Analysis section shows whether they are configured.
- PaddleOCR 3.7 with pinned English and Arabic PP-OCRv5 ONNX models is a second private OCR path after RapidOCR when the first pass cannot recover a ledger. Its models are downloaded during the worker image build and verified before use.
- Conservative paired self-transfer exclusion, joint-account income exclusion, salary candidate and observed-employer timeline, normalized counterparties, recurring obligations, daily booked balances, per-currency cash flow, liquidity, and overdraft/card/loan facility separation.
- Bounded direct, multi-hop, and split/recombine self-owned cycle signals, protected savings-transfer control, and review-only irregularity signals.
- Six selectable, formula-labeled credit review models (`credit_models` JSON array): observed repayment-to-salary ratio, residual monthly cash flow, income variability, observed liquidity runway, UAE debt burden ratio, and business debt-service coverage ratio. The final two require independent income and liability verification and return no calculated ratio from a statement alone. No model returns a credit decision. Review priorities flag repeated cash deficits on externally funded accounts, variable candidate credits, negative booked balances, unreconciled ledgers, salary gaps, large credit outliers, duplicate pages, and transfer cycles; the JSON retains evidence IDs and recommended checks.
- Authenticated canonical ledger JSON, Parquet transaction export, optional private PDF audit summary (`get_pdf=true`), and optional styled XLSX (`get_xlsx=true`) with Overview, Cash Flow, Ledgers, Review Signals, Transactions, and Methodology sheets. Workbook text from statements is escaped as data, never executed as a spreadsheet formula. The admin UI offers a private analysis link (`/admin?analysis=<id>`) that requires an active admin session; the XLSX download uses its session-protected route. A direct link alone does not grant access.

## Current limits

The generic path covers a useful class of legible tables; it cannot reliably interpret every visual layout, locale, image scan, or missing field. Image bundles are normalized into a PDF and use the same bounded OCR path. Arabic digits, metadata, and right-to-left column order are handled in the generic parser. Both OCR libraries use pinned ONNX models, and the worker refuses missing or changed models. For local Python runs, install RapidOCR models with `PYTHONPATH=bank-statement-analysis/src python3 bank-statement-analysis/scripts/install_ocr_models.py --target <model-directory>` and PaddleOCR models with `PYTHONPATH=bank-statement-analysis/src python3 bank-statement-analysis/scripts/install_paddle_models.py --target <paddle-directory>`, then set `BSA_OCR_MODEL_ROOT` and `BSA_PADDLE_MODEL_ROOT`. A scanned synthetic Arabic statement did not yet extract reliably end to end, so broad Arabic scan support remains unvalidated. Tables with ambiguous dates or multiple reconciling interpretations remain inconclusive. OCR amounts are never silently repaired; unreadable rows or balance mismatches prevent full reconciliation. The visual/native comparison is heuristic and limited to twelve text-bearing pages per job; pages it cannot verify produce a partial result. Real-statement results remain partial and `decisionEligible` is always false. A ClamAV INSTREAM gate is available through `BSA_CLAMD_SOCKET`; without a configured daemon the result explicitly records `malwareGate: not_configured_local_demo`. Live Azure Document Intelligence processing, Azurite-backed storage, approved FX reporting, callbacks, and retention/deletion policy are still open. Previously created local demo jobs may use plaintext files; new jobs are encrypted. Local job files are retained until an approved lifecycle policy exists. The `BSA_LOCAL_ENABLED` gate prevents this route from being activated in production.

### Managed Layout activation boundary

The default local demo makes **zero** managed extraction calls. The worker constructs the v4 Layout adapter only when `BSA_MANAGED_EXTRACTION_APPROVED=1`. A call also requires an HTTPS Azure endpoint and key, matching `BSA_AZURE_LAYOUT_REGION` and `BSA_APPROVED_PROCESSING_REGION`, positive `BSA_MANAGED_MAX_PAGES`, `BSA_MANAGED_MAX_COST_USD`, and `BSA_MANAGED_ESTIMATED_PAGE_COST_USD`. These values are currently unset. Never use real statements to exercise this route until the region, privacy, and cost decisions are approved. The adapter uses `prebuilt-layout`, polls its operation, and calls Delete Analyze Result after retrieval. It does not request a document URL or persist the raw provider response.

## Verify

```bash
npm test
cd bank-statement-analysis && PYTHONPATH=src python3 -m pytest -q
```

The API test covers auth, tenant isolation, idempotency, input rejection, encrypted input storage, and authenticated artifact retrieval. Python tests cover multi-statement reconciliation, property-based decimal invariants, ownership, image conversion, facilities, cycle controls, malware protocol behavior, private artifacts, OCR table parsing, native ADCB table reconciliation, generic native and scanned tables, a mocked Azure Layout operation through reconciled ledger output and deletion, and a visual/invisible PDF text mismatch. Run the synthetic throughput harness with `python3 bank-statement-analysis/scripts/benchmark_local.py --iterations 3`.
