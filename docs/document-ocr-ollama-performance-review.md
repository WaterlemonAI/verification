# Document OCR release performance review: Azure/Gemini and CPU Ollama

Date: 1 November 2026. Scope: the eight document extraction APIs in PR #106 and the isolated UAE North CPU QA run. This report contains no source document text, identity values, images, or model responses.

## Decision

**Performance gate failed for both extraction paths.** The stated acceptance limit is 10 seconds for a simple two-page **completed OCR result**. The user reports that the existing Azure/Gemini production path also fails this gate; its measured elapsed time was not provided in this review. The proposed Ollama path independently failed: a one-page Emirates ID took about **265 seconds to finish page transcription** on a 3-vCPU, 6-GiB Azure Container Apps job. Field structuring then waited about **301 seconds** and failed at Node's default response-header timeout. No valid Ollama result was produced. The original Ollama attempt failed after about 559 seconds; the diagnosed repeat failed after 566 seconds. The other four supplied PDFs were not completed on Ollama, so their field accuracy and latency are unverified.

Neither path is release-gate compliant. Azure/Gemini remains the configured default only to prevent an unverified Ollama cutover; that default is **not** a performance approval. Do not enable `DOCUMENT_OCR_FORCE_OLLAMA` or select Ollama per API from the admin control. The production API currently has `DOCUMENT_OCR_PRODUCTION_ENABLED=1`, so the existing routes remain available despite the reported latency failure. Changing customer admission requires an explicit rollout decision. PR #106 is a draft.

## Existing production path: latency review

The live worker in UAE North has two 2-vCPU containers, one for document OCR and one for ClamAV. It scales from zero to at most two replicas and its Azure Queue scaling rule polls every 30 seconds. The API returns HTTP 202 after enqueueing; customers poll a separate result URL until HTTP 200. The release gate must therefore measure submission to **result availability**, not the initial 202 response.

After the worker starts, it downloads and decrypts the file, scans it with ClamAV, submits it to Azure Document Intelligence, polls for analysis completion, checkpoints OCR, calls Gemini for structured fields, validates evidence and MRZ where applicable, stores the encrypted result, and settles billing. Code bounds are 90 seconds for Azure submission, up to 180 one-second Azure polls, and 60 seconds for Gemini. These are limits, **not observed stage durations**. The scaler may wait until its next 30-second poll before waking a zero-replica worker, and [Document Intelligence analysis itself is asynchronous](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response). This makes a strict 10-second end-to-end guarantee implausible for the current design, even before provider time is counted; a warm-worker benchmark is still needed to isolate provider latency. [Azure Container Apps scaling documentation](https://learn.microsoft.com/en-us/azure/container-apps/scale-app) describes the polling behavior.

The production Container App configuration and enabled API flag were read on 1 November 2026. The Log Analytics workspace contains no usable OCR-worker stage timings for this review. Querying `DocumentOcrJobs` for created-to-completed timestamps was denied because this session lacks Storage Table Data Reader permission. No exact production percentile or stage breakdown is claimed here. The user's report of the failed release test is the current acceptance evidence until a sanitized timing export is available.

For a 10-second completed-result target, a candidate redesign would keep a short-document worker warm, bypass queue wake-up on the latency-critical route, and benchmark a faster extraction/structuring combination end to end. That is a design hypothesis, not a verified fix. Long MOA and POA files may need a separate asynchronous turnaround target; the 10-second limit should not be asserted for them without a measured result. Keep the current customer admission decision separate from the Ollama migration decision.

## End-to-end process reviewed

| Stage | Current proposed Ollama path | Time evidence and effect |
| --- | --- | --- |
| Admission | Authenticated API validates file type, size, page limit, entitlement and idempotency, then stores encrypted input and queues a job. | Not timed in this direct QA run. A fast HTTP 202 is not a completed OCR result. |
| Scale and start | Queue rule can scale from zero; worker starts Ollama and ClamAV, then checks the bundled model. | Not included in `QA_START` timing. Cold start and model-image pull add to customer latency. |
| Scan and download | Worker downloads input, runs ClamAV, counts pages, and checkpoints progress. | Direct QA used private Blob download and page count, but skipped the production queue, ClamAV, and billing path. Its measured time is therefore a lower bound for the live path. |
| Page extraction | PDF pages without sufficient embedded text are rendered at up to 1800 px and sent one at a time to `qwen3-vl:4b-instruct` through Ollama. Passport and Emirates ID always use vision so MRZ characters can be checked. | One Emirates ID page reached `page_extraction_complete` after about 265 seconds, including Blob download, rendering, model load, and inference. These substeps were not separately timed in Azure. On a local workstation, rendering the same page took 96 ms; this does not establish Azure render time. |
| Text-layer shortcut | Business PDFs with at least 200 visible characters per page use embedded text; other pages use vision. | The supplied trade licence has 8 text pages and 1 vision page. The POA has 9 text pages; the MOA has 14. This removes most vision calls for those PDFs but does not remove model structuring calls. |
| Field structuring | OCR text is split into 8,000-character chunks. Ollama receives the full schema in both prompt and constrained `format` for every chunk. Calls run sequentially; each can generate up to 4,096 tokens (8,192 for MOA). | The Emirates ID's first structuring call had not returned headers after about 301 seconds. The supplied trade licence, POA, and MOA would require approximately 7, 7, and 12 sequential structuring calls respectively, based on their embedded text lengths. These are planned-call counts, not observed runtimes. |
| Validation and result | Deterministic schema/evidence checks, MRZ checks, Emirates ID crop requests, encrypted result storage, and billing settlement follow model output. | Not reached in live Ollama QA. Synthetic unit tests cover contracts, but no real-sample Ollama field output was verified. |

## Causes and confidence

1. **Measured bottleneck: CPU model work.** A single-page QA attempt consumed minutes in page extraction and the next model call exceeded five minutes. The local PDF rendering measurement is much smaller than the page extraction total. Model load and inference were not individually instrumented, so their exact shares remain unknown.
2. **Confirmed transport failure:** Node's built-in `fetch` raised `UND_ERR_HEADERS_TIMEOUT` after roughly five minutes without Ollama response headers, despite a 600-second abort signal. The Ollama client now uses `node:http` with an explicit 20-minute abort. This prevents that premature failure; it does not make inference faster or prove a result would complete.
3. **Confirmed serial-call multiplication:** `chunksForPages` and `structureDocumentWithOllama` run one model request per text chunk in sequence. Long legal documents cause many repeated schema prompts and model completions. This makes the 10-second result target even less plausible than the one-page measurement.
4. **Likely cold-start penalty:** scale-to-zero, a large model baked into the image, and `keep_alive: '0'` on the last structuring call can cause image/model loading again for later jobs. This was identified from configuration, not separately measured in the QA run.
5. **Resource mismatch:** QA used 3 vCPUs and 6 GiB for the OCR container. The proposed production Bicep gives that container 2 vCPUs and 6 GiB alongside a 2-vCPU ClamAV sidecar. The QA result cannot be projected as a production benchmark, but the production OCR container has fewer vCPUs than the failed QA container.

No output quality conclusion can be drawn from a failed request. The prompt-injection defenses in the proposed path are: document text is explicitly marked untrusted, instruction-like lines are removed before structuring, the model has no tools or external endpoint, output must match the schema, populated fields need page quotes, and MRZ check digits are verified in code. Synthetic injection tests pass. A real-document injection and field-accuracy gate remains open.

## Real sample QA record

| Supplied case | Pages | Ollama QA outcome |
| --- | ---: | --- |
| Emirates ID | 1 | Vision transcription completed in about 265 s; structuring timed out after about 301 s; no result. |
| Passport | 2 | Started only briefly after the Emirates ID failure; stopped without a result. |
| UAE trade licence | 9 | Not run to a result; 8 text-layer pages and 1 image-only page identified locally. |
| UAE power of attorney | 9 | Not run to a result; 9 text-layer pages identified locally. |
| Memorandum of association | 14 | Not run to a result; 14 text-layer pages identified locally. |

The Google Drive MOA placeholder was unreadable locally; an equal-sized readable copy from the user's local Samples directory was used for page analysis. No document was committed or sent to GitHub. The QA input container prefix and output prefix were checked empty after cleanup. The temporary ACA QA job and QA-only ACR images were deleted; the final QA ACR build was canceled.

## Change ledger for PR #106

| Files | Change | Status |
| --- | --- | --- |
| `lib/document-ocr-ollama.mjs`, `Dockerfile.document-ocr`, `scripts/run-document-ocr-worker.mjs` | Bundled Qwen vision model; local transcription and JSON structuring; PDF text-layer shortcut; loopback HTTP transport and longer CPU-call timeout. | Implemented, latency gate failed. |
| `lib/document-ocr-worker.mjs`, `lib/document-ocr-store.mjs`, `lib/document-ocr-identity-images.mjs`, `lib/document-ocr-engine.mjs` | Queue checkpointing and visibility, Ollama call accounting, MRZ and crop handling, evidence and injection validation. | Unit tested; real Ollama result not verified. |
| `lib/api-store.mjs`, `server.mjs`, `admin-site/admin.js`, `admin-site/admin.css`, `admin-site/index.html` | Per-API engine selection and admin display. Local and production defaults are Azure while QA is blocked. | Default aligned after review. |
| `infrastructure/api.bicep`, `scripts/guard-document-ocr-whatif.mjs`, `.github/workflows/deploy-api.yml` | Worker image, CPU/ClamAV resources, scale rule, and reviewed deployment gate. | Proposed only; production cutover not performed. |
| `.github/workflows/document-ocr-pr-checks.yml`, `scripts/document-ocr-ollama-smoke.mjs` | Bundled-image CPU smoke, schema and injection checks. | Synthetic image CI was canceled after the real-sample latency gate failed. |
| `test/document-ocr-ollama.test.mjs`, `test/document-ocr-api.test.mjs`, `test/document-ocr-engine.test.mjs`, `test/document-ocr-identity-images.test.mjs`, `test/document-ocr-whatif.test.mjs`, `test/admin-auth.test.mjs` | Focused contracts, transport, text-layer, security, and rollout tests. | All 287 repository tests pass locally after the review changes. |
| `docs/document-ocr-release.md`, this report | Staged rollout instructions and the measured failure/decision record. | Updated. |

## Required next gate

Measure both the existing Azure/Gemini path and any replacement against **completed** two-page results in at most 10 seconds, including cold and warm runs, while retaining all eight output schemas and evidence checks. Instrument separate timings for admission/storage, queue wait, image pull, malware scan, Azure submit/poll or local render/vision, model load, field structuring, validation, and result storage. Record p50 and p95 latency, CPU/memory, field accuracy, MRZ validity, and prompt-injection behavior on representative documents. The current Qwen 4B, 2-vCPU, scale-to-zero design should not be enabled on the basis of a timeout increase or synthetic smoke tests. The existing Azure/Gemini path should not be described as release-gate compliant merely because it is the current production default.
