# Adverse Media Advance: Jev integrated test API

This internal, JSON-only endpoint is ready for controlled integrated testing. It does not change the customer Advance route, generate a PDF, call Gemini, send callbacks, or publish an adverse-profile decision.

## Endpoint

`POST /internal/adverse-media-jev/integrated-test`

Use the same internal bearer token and feature flag as the existing Jev screening and incident APIs:

- `ADVERSE_MEDIA_JEV_API_ENABLED=true`
- `ADVERSE_MEDIA_JEV_SCREENING_TOKEN`: at least 32 characters
- Brave credential: server-side `adverse-media` master key
- Jev credential: server-side `adverse-media-jev` master key
- Event Registry credential: server-side `EVENT_REGISTRY_API_KEY`

Example request:

```json
{
  "subject": { "name": "Example Trading LLC", "entity_type": "business", "aliases": [] },
  "adverse_profile": "all",
  "countries": [],
  "date_from": "2026-11-01",
  "date_to": "2026-11-25",
  "max_articles": 4,
  "max_archive_postings": 500
}
```

`adverse_profile` must be `all`, selecting the 64-ID Advance policy catalog as the test scope. This route records the full catalog selection but does **not** yet perform per-policy adjudication; `policy_evaluation_status` is `not_run`. `countries` must be `[]` for global scope. Dates default to the most recent 30 calendar days and the requested span must not exceed 31 calendar dates. `max_articles` defaults to 8 and cannot exceed 40. `max_archive_postings` defaults to 500 and cannot exceed 1,000. Up to three caller-supplied aliases are accepted. Optional `subject.transliterations` has the form `{"ar":["Arabic spelling"],"hi":["Hindi spelling"]}`, with at most one name in each script. The primary name and aliases share the base news/web query; each transliteration receives its own news/web query and enters archive lookup. The report API generates these variants when omitted; this JSON-only route searches only those supplied. The archive branch requires a current V2 snapshot, then pages the V1 postings that underlie its point summary. This is a bounded test; an incomplete scan or an archive shortlist larger than the article limit fails before paid extraction.

## Processing and source proof

1. The route checks a V2 point-summary snapshot and pages the underlying subject postings. It records the number scanned and applies the versioned **748-term title/URL selector** with a subject-name or approved-alias match. It retains the selector's matched name, terms, categories, and exclusion count. Any scan or shortlist limit is explicit and fails closed.
2. It calls Event Registry's per-URL `extractArticleInfo` API for **every** shortlisted archive URL in the bounded test window. The existing URL, title, canonical and publisher checks must pass. Extraction failures remain metadata records.
3. It makes one base news and one base web search, plus one news/web pair for each supplied transliteration. Search hits must contain the normalized subject name, alias, or searched transliteration in the title or URL before entering the register. It merges them with the enriched archive URLs by canonical URL, preserving source provenance. All shortlisted archive URLs take priority in the bounded register; remaining slots are filled from search. It extracts up to five selected search URLs until three body-bearing articles are available. If articles were selected, at least one must have a verified body of 300 or more characters. If no articles were selected, the route returns an empty event register without a screening call. The response reports search items omitted by the test limit. A valid empty web/news result is treated as zero hits.
4. Jev screens each selected article for subject association, one of `adverse | non-adverse | inconclusive`, and one of `direct | indirect | inconclusive`. Redundant articles are removed and separately tagged. **Only adverse retained articles** enter specific-incident eligibility and shared-incident comparison. Non-adverse and inconclusive articles remain in the register's review section and cannot create incident buckets.
5. The response contains the retained event register, redundant items, incident markers, archive and provider counts, selected and omitted counts, and Jev call and byte-reserve counts. `coverage.event_registry.body_selected` proves how many selected articles supplied usable Event Registry text. Each article includes source provenance, archive term matches, evidence grade, text length, SHA-256, and Jev screening probabilities, but not full article text. `incident_review` retains Jev eligibility and pair judgments for audit. `report_generated` is `false`; there is no report link or PDF.

The route reserves at most $0.15 of Jev input by request bytes before sending Jev calls. It calls Event Registry once per unique shortlisted archive URL, with bounded retries, and Brave twice plus twice per transliteration. Their provider charges are separate from the Jev reserve. A successful response does not claim all search results were reviewed: `coverage.omitted_due_to_test_limit` reports the bounded overflow.

## Failure behavior

- `400`: invalid input, profile, geography, date window, or article cap.
- `401`: missing or incorrect internal token.
- `424`: V2 snapshot or archive scan is unavailable/incomplete, the archive shortlist exceeds the test cap, or selected articles exist but none has an extracted body of at least 300 characters.
- `503`: feature flag off or one of the three provider credentials missing.
- `502`: source failure, invalid provider answer, or Jev failure.
- `413`: request body or Jev reserve limit exceeded.

The endpoint returns no partial success if a source or Jev fails. Credentials and provider error bodies are not returned.

## Verification

`node --test test/adverse-media-jev-integrated.test.mjs test/adverse-media-jev-screening.test.mjs test/adverse-media-jev-incidents.test.mjs`

The integration test uses a mocked V2 point summary, paged archive postings, Event Registry extraction, Brave, and Jev responses. It verifies that the 748-term archive selector chooses the subject's adverse headline, Event Registry's full text enters the merged register, overlapping Brave provenance survives, Jev screening and incident grouping run, and no Gemini or PDF call occurs. Live provider validation requires an isolated environment with V2 storage, all three provider credentials, and a subject/date window under the explicit caps.
