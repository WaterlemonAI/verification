# Document OCR release performance review: Azure/Gemini and CPU Ollama

Date: 1 November 2026. Scope: the eight document extraction APIs in PR #106, isolated UAE North CPU QA runs, and a five-document authenticated production API timing run. This report contains no source document text, identity values, images, credentials, or model responses.

## Decision

**Performance and completion gates failed for all tested extraction paths.** The stated acceptance limit is 10 seconds for a simple two-page **completed OCR result**. In a new authenticated production API run, all five supplied PDFs reached HTTP 422 after Azure analysis and a Gemini HTTP 429. Client-observed submission-to-terminal times ranged from **10.35 to 74.45 seconds**; none produced usable OCR output. The proposed all-Ollama path independently failed: a one-page Emirates ID took about **265 seconds to finish page transcription** on a 3-vCPU, 6-GiB Azure Container Apps job. Field structuring then waited about **301 seconds** and failed at Node's default response-header timeout. No valid all-Ollama result was produced. The original all-Ollama attempt failed after about 559 seconds; the diagnosed repeat failed after 566 seconds. The new temporary **Azure OCR → Ollama structuring** path produced a two-page passport result but took **90.10 seconds** on 2 vCPUs. The other four supplied PDFs were not completed on the all-Ollama path, so their field accuracy and latency there are unverified.

None of these paths is release-gate compliant. Azure/Gemini remains the configured default only to prevent an unverified Ollama cutover; that default is **not** a performance approval. Do not enable `DOCUMENT_OCR_FORCE_OLLAMA` or select Ollama per API from the admin control. The production API currently has `DOCUMENT_OCR_PRODUCTION_ENABLED=1`, so the existing routes remain available despite the reported latency failure. Changing customer admission requires an explicit rollout decision. PR #106 is a draft.

## Temporary Azure OCR → Ollama structuring QA

This requested experiment keeps the existing Azure Document Intelligence OCR call (`prebuilt-idDocument` for passport, `prebuilt-layout` for the other document APIs) and replaces only Gemini field analysis with local, CPU-only Ollama. It is an isolated manual Azure Container Apps job in UAE North; no production route, queue worker, engine setting, or customer result path invokes it. The job downloads the supplied PDF from private QA Blob storage, calls the same `analyzeDocumentWithAzure` function as production, and passes its OCR pages to `structureDocumentWithOllama`. The shared Gemini system instruction is now used verbatim by Ollama, with a text-only rule for image regions. The existing OCR sanitization, eight API schemas, page-quote evidence checks, `Not Found`/`Not Readable` behavior, review flags, and MRZ validation remain in the path. The model has no external tools.

The first live sample was the supplied two-page passport on a 2-vCPU, 4-GiB job using `qwen3:0.6b`, a small text-only model baked into the QA image. It returned 12 populated fields, 12 fields with evidence, the expected passport classification, and a passing MRZ integrity status. Those checks establish a schema-complete result with evidence, **not** field-by-field ground-truth accuracy. The QA runner stored the full output privately; this report records only aggregate metrics.

| Stage | Measured time |
| --- | ---: |
| Private Blob download | 0.67 s |
| Azure Document Intelligence OCR | 5.51 s |
| Ollama field structuring | 83.92 s |
| Download to completed result, excluding final QA Blob upload | **90.10 s** |

The job was already running when timing started. It did not include production API admission, queue waiting, ClamAV scanning, billing, or a customer result poll. It therefore cannot demonstrate a 10-second customer completion time. A single field-analysis call alone exceeded that budget eightfold. Emirates ID portrait/signature crops were not supplied to this text-only experiment, so its full image-region contract remains unverified.

An instrumented repeat on the same passport, model, and 2-vCPU/4-GiB job completed in **87.91 seconds**: private Blob download 0.97 s, Azure OCR 6.05 s, and Ollama structuring 80.89 s. Ollama reported **1.80 s model load**, **9.62 s prompt evaluation** for 2,251 input tokens, and **69.43 s generation** for 678 output tokens. The model generated about **9.8 tokens/s**. The repeat again returned 12 populated fields with 12 evidence fields, the expected classification, and a passing MRZ status. Generation is the dominant measured cost; removing cold model load would still leave roughly 86 seconds in this direct path. Both runs fail the 10-second gate before production queue and scanning overhead. The other supplied documents were not run through this hybrid path because the simple two-page case already failed the required latency gate; no claim is made about their live field accuracy.

After the runs, the manual QA job and QA-only ACR repository were deleted. Both private Blob prefixes were checked empty, and the local deployment scratch directory was removed. The QA runner and Dockerfile remain in this draft PR solely to make the experiment reviewable and repeatable; they are not part of the production worker image or deployment.

## Existing production path: latency review

The live worker in UAE North has two 2-vCPU containers, one for document OCR and one for ClamAV. It scales from zero to at most two replicas and its Azure Queue scaling rule polls every 30 seconds. The API returns HTTP 202 after enqueueing; customers poll a separate result URL until HTTP 200. The release gate must therefore measure submission to **result availability**, not the initial 202 response.

After the worker starts, it downloads and decrypts the file, scans it with ClamAV, submits it to Azure Document Intelligence, polls for analysis completion, checkpoints OCR, calls Gemini for structured fields, validates evidence and MRZ where applicable, stores the encrypted result, and settles billing. Code bounds are 90 seconds for Azure submission, up to 180 one-second Azure polls, and 60 seconds for Gemini. These are limits, **not observed stage durations**. The scaler may wait until its next 30-second poll before waking a zero-replica worker, and [Document Intelligence analysis itself is asynchronous](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response). This makes a strict 10-second end-to-end guarantee implausible for the current design, even before provider time is counted; a warm-worker benchmark is still needed to isolate provider latency. [Azure Container Apps scaling documentation](https://learn.microsoft.com/en-us/azure/container-apps/scale-app) describes the polling behavior.

The production Container App configuration and enabled API flag were read on 1 November 2026. The Log Analytics workspace contains no usable OCR-worker stage timings for this review. Direct `DocumentOcrJobs` queries were denied because this session lacks Storage Table Data Reader permission; the authenticated result endpoint did provide job creation/completion timestamps and provider-call counts. No production percentile or internal stage breakdown is claimed from five samples. The live test established a persistent Gemini 429 after one Azure analysis per document. A separate minimal synthetic call to the configured `gemini-3.5-flash-lite` model also returned HTTP 429 `RESOURCE_EXHAUSTED`; the provider response did not reveal a precise quota. [Google's Gemini guidance](https://ai.google.dev/gemini-api/docs/troubleshooting) identifies 429 as a resource/rate-limit error and advises checking project limits and using bounded backoff for transient cases. Backoff would increase latency and is not a 10-second fix.

### Authenticated production API timing run — 1 November 2026

Five user-supplied PDFs were submitted one at a time with fresh idempotency keys to the enabled production OCR routes. Time starts immediately before POST and ends when the result endpoint first returns a terminal response; polling every three seconds can add up to three seconds of observation delay. The first request encountered a cold queue worker, while later requests ran with the worker warm. Every result was HTTP 422, not a successful OCR result.

| Case | Pages | POST to 202 | Created to failed | Client-observed end to end | Provider calls | Terminal reason |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Passport | 2 | 11.45 s | 60.48 s | 74.45 s | Azure 1, Gemini 1 | Gemini HTTP 429 |
| Emirates ID | 1 | 0.74 s | 12.19 s | 13.74 s | Azure 1, Gemini 1 | Gemini HTTP 429 |
| UAE trade licence | 9 | 0.94 s | 10.28 s | 13.84 s | Azure 1, Gemini 1 | Gemini HTTP 429 |
| UAE power of attorney | 9 | 0.63 s | 7.93 s | 10.35 s | Azure 1, Gemini 1 | Gemini HTTP 429 |
| Memorandum of association | 14 | 2.85 s | 10.44 s | 15.10 s | Azure 1, Gemini 1 | Gemini HTTP 429 |

The run used the existing internal AI7LAB UAE test workspace. Its temporary key was revoked and verified revoked; the local plaintext key was removed. Production job/input records follow the configured retention policy. The Google Drive MOA placeholder was unreadable locally, so the equal-sized readable local Samples copy was submitted. No file or extracted value was committed to GitHub.

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
| `test/document-ocr-ollama.test.mjs`, `test/document-ocr-api.test.mjs`, `test/document-ocr-engine.test.mjs`, `test/document-ocr-identity-images.test.mjs`, `test/document-ocr-whatif.test.mjs`, `test/admin-auth.test.mjs` | Focused contracts, transport, text-layer, security, and rollout tests. | The earlier 287-test repository run passed; the new shared-prompt changes passed 22 focused tests. |
| `scripts/document-ocr-azure-ollama-qa.mjs`, `Dockerfile.document-ocr-azure-ollama-qa` | Isolated Azure OCR → Ollama field-analysis experiment with a baked CPU text model and aggregate stage timings. | Temporary manual QA job only; not referenced by production. |
| `lib/document-ocr-engine.mjs`, `lib/document-ocr-ollama.mjs`, `test/document-ocr-ollama.test.mjs` | Export Gemini's exact system instruction and reuse it for Ollama, with a text-only image-region rule; assert shared injection and MRZ rules. | Focused tests pass, 22/22. |
| `docs/document-ocr-release.md`, this report | Staged rollout instructions and the measured failure/decision record. | Updated. |

## Required next gate

Resolve the configured Gemini model's HTTP 429 first, including the project/model quota or billing state; do not count an HTTP 422 failure as a completed OCR result. Then measure both the existing Azure/Gemini path and any replacement against **successful or review-required** two-page results in at most 10 seconds, including cold and warm runs, while retaining all eight output schemas and evidence checks. Instrument separate timings for admission/storage, queue wait, image pull, malware scan, Azure submit/poll or local render/vision, model load, field structuring, validation, and result storage. Record p50 and p95 latency, CPU/memory, field accuracy, MRZ validity, and prompt-injection behavior on representative documents. The current Qwen 4B, 2-vCPU, scale-to-zero design and the measured Azure OCR → Qwen3 0.6B design should not be enabled on the basis of a timeout increase or synthetic smoke tests. The existing Azure/Gemini path should not be described as release-gate compliant merely because it is the current production default.
