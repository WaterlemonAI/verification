# TAED document extraction integration

This draft PR integrates the TAED API for the existing MOA OCR route. The other seven document routes continue to use the current extraction pipeline until their TAED `api_id` values and response contracts are provided. The earlier GPT OCR PR remains separate.

## MOA request

The customer continues to submit to `/service/moa_analysis` and poll the existing job and result URLs. When `DOCUMENT_OCR_TAED_MOA_ENABLED=true` at submission, the job stores the TAED pipeline choice so a later setting change does not reroute it. The setting defaults off. The MOA route accepts PDF, PNG, JPEG, and WEBP for TAED jobs, with one file up to 25 MiB and 50 pages. The file passes the existing malware scan before extraction.

The worker sends `POST https://www.taed.dev/api/v1/extract` with the protected `X-API-Key`, multipart `api_id=5070ccf6-a243-4e5e-8fb1-e5360ffb3ab0`, and `file`. In production, store the key through the internal `document-ocr-taed` integration. Local tests can use `DOCUMENT_OCR_TAED_API_KEY`. No key is committed.

## MOA result

The worker maps TAED's `data` object to the existing snake_case MOA fields. It parses a stringified shareholder JSON array into separate rows and adds number of shares, joining date, removal date, and current status. `phone_number` remains in every shareholder row as `Not Found` for compatibility. Missing values use `Not Found`. The TAED `metadata` block is discarded.

The TAED MOA result contains only the job envelope and `data`. Job status and submission receipts omit provider call counts. TAED results omit review flags, confidence, model names, and usage details. Older jobs retain their existing response format.

The adapter validates upload type and size, bounds the response, and maps documented TAED errors `EXTRACTION_PIPELINE_FAILURE` (500), `MODEL_COMPLIANCE_REFUSAL` (403), `SCHEMA_MISMATCH_EMPTY_OUTPUT` (422), and `UNREADABLE_IMAGE_CONTENT` (422) to safe internal codes. It does not log the API key, file, or provider response body.

## Remaining before activation

Add the TAED credential to the protected store, then enable `DOCUMENT_OCR_TAED_MOA_ENABLED=true` for the API deployment. This PR does not activate the switch. No real document has been sent to TAED during development. The seven remaining document types need their TAED IDs and example responses before they can be integrated.
