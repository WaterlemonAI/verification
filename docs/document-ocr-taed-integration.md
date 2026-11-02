# TAED document extraction integration — draft

This branch prepares a separate provider adapter for the eight existing document OCR APIs. It does not change the production worker or customer response yet.

## Confirmed request contract

- `POST https://www.taed.dev/api/v1/extract`
- Header: `X-API-Key` from a protected secret
- Multipart fields: `api_id` and `file`
- Maximum file size: 25 MiB
- Supplied mapping: `moa-analysis` → `5070ccf6-a243-4e5e-8fb1-e5360ffb3ab0`
- Accepted TAED media: PDF, PNG, JPG, WEBP

The updated MOA contract supplied by the owner asks for company name, registration number, business objectives, authorized capital, incorporation date, and a row per shareholder. Each row needs name, ID number, nationality, percentage share, number of shares, date of joining, date of removal, and status (`Active Shareholder` or `Removed Shareholder`). The current public MOA schema also includes shareholder `phone_number`; its compatibility treatment is pending an owner choice.

Documented TAED errors are `EXTRACTION_PIPELINE_FAILURE` (500), `MODEL_COMPLIANCE_REFUSAL` (403), `SCHEMA_MISMATCH_EMPTY_OUTPUT` (422), and `UNREADABLE_IMAGE_CONTENT` (422). The adapter maps these to internal codes without returning provider messages.

The adapter keeps the endpoint fixed, checks the upload before sending it, bounds the response, and turns provider failures into safe internal error codes. It does not log the API key, file, or provider response body.

## Required to finish the PR

1. Receive the seven remaining document-type `api_id` values.
2. Receive a redacted success response. The response field path and confidence format cannot safely be inferred from the cURL request and field list alone.
3. Store the TAED key in the existing protected credential path; do not commit it or put it in the PR.
4. Map each response to the existing eight public field contracts, with each field returning only `value` and a 0–1 `confidence`. Exclude review flags, model names, and usage metadata from the customer-facing result, as requested.
5. Add contract tests and a synthetic sandbox run before changing the production worker or deployment configuration.

The TAED public [privacy policy](https://www.taed.dev/privacy) says uploads can pass through temporary private storage and that downstream provider processing follows those providers' policies. Confirm this processing path for identity documents before enabling live traffic.
