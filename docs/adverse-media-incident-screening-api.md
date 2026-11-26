# Adverse Media Incident Screening API

This is a new KYCProbe product. It does not replace or change `/service/adverse_media_advance`.

## Contract

The product ID and billing module are `adverse-media-incident-screening`. The customer endpoint is `POST /service/adverse_media_incident_screening`. It requires a workspace API key, a separate product entitlement and rate, and an `Idempotency-Key` of 16–128 permitted characters. The feature switch `ADVERSE_MEDIA_INCIDENT_SCREENING_ENABLED` is off by default. The request supports one subject, at most three aliases, an optional 30-day date window, and up to 40 articles. `adverse_profile` is always `all`; an omitted value defaults to `all`. Countries are currently global only (`[]`).

```http
POST /service/adverse_media_incident_screening
Authorization: Bearer <workspace-api-key>
Idempotency-Key: check-2026-11-26-example-001
Content-Type: application/json

{"subject":{"name":"Example Trading LLC","entity_type":"business","aliases":[]},"adverse_profile":"all","countries":[],"date_from":"2026-11-01","date_to":"2026-11-25","max_articles":40}
```

The API returns HTTP 202 with `screening_id`, `status: queued`, and `status_url`. Poll `GET /service/adverse_media_incident_screening/jobs/{screeningId}` with the same workspace API key. A completed response has `result` containing the finalized JSON, incident groups, and `report.pdf_url`. Download the private PDF using `GET /service/adverse_media_incident_screening/reports/{reportId}.pdf` with the same key. The PDF is explicitly unsigned and the JSON reports `digitally_signed: false`.

Identical accepted submissions with the same idempotency key return the original `screening_id` without another charge. A different payload with that key returns 409. A completed check keeps one charge; a worker failure is refunded. Failed jobs return `status: failed` and no PDF. The event register and PDF contain no internal provider or tool names.

The customer API uses the existing Brave credential, Azure archive, and three separate admin credential slots: `adverse-media-jev` for screening, `adverse-media-summary` for name variants and summaries, and `adverse-media-article-extraction` for full-text extraction. The extraction slot may be supplied by the existing `EVENT_REGISTRY_API_KEY` runtime secret where that secret is correctly provisioned. These credentials are server-side and never accepted from the caller. The incident queue and dead-letter queue are separate from the older deep-research queue, including a distinct QA queue when deployed in parallel mode. Queue visibility is one hour; an interrupted job fails and is refunded rather than repeating provider calls without a checkpoint.

See [the standalone OpenAPI contract](/Users/zainabkhan/Documents/ChatGPT/verification-adverse-advance/api/adverse-media-incident-openapi.json) for fields and response codes.

## Release gates

The new switch stays off until the reviewed source is on `main`, the QA app can reach the archive and the separate queue, and an adverse incident plus a no-adverse case both complete through the public API. Verify the PDF, private cross-workspace access, one-charge replay, failure refund, and provider-neutral JSON. Promote the same digest to the production Container App, configure the two admin credentials there, then enable this product for selected workspaces with its own rate. The PDF certificate is deferred; this release uses unsigned PDFs by owner direction.
