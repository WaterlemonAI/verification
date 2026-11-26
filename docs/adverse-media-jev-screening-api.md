# Jev event-register screening API

Status: implemented for internal evaluation on 25 November 2026. The current Adverse Media Advance production pipeline still uses its existing classifier; customer access remains off. A separate [100-article Jev QA run](../output/adverse-advance-qa-2026-11-25/consolidated-event-register/jev-100-checks/qa-report.md) is retained locally. [Incident grouping](adverse-media-jev-incident-grouping-api.md) is a separate internal API.

The [integrated JSON-only test API](adverse-media-jev-integrated-test-api.md) now retrieves bounded Brave and Event Registry articles before calling these Jev APIs.

## Contract

`POST /internal/adverse-media-jev/screen` accepts a screened subject and 1–20 event-register articles. It makes one pinned `jev-1.14.0` request per article with three independent questions: subject association (Noul), adverseness (Choice), and relationship (Choice). The Choice criteria admit exactly these values:

| Field | Allowed values |
| --- | --- |
| `adverseness` | `adverse`, `non-adverse`, `inconclusive` |
| `relationship` | `direct`, `indirect`, `inconclusive` |

An association probability at or below 0.30 marks the article `redundant` and removes it from `event_register.articles`. A probability from above 0.30 to below 0.70 retains the article with `relationship: inconclusive`. These are provisional evaluation thresholds, to be checked against the user's labeled sample registers. An article with only a title is retained with both labels `inconclusive` and is not sent to Jev. `direct` includes an affected subject and does not assert culpability. `indirect` requires a supported related person or entity. `inconclusive` is not a negative finding.

Example request:

```json
{
  "subject": { "name": "Example Trading LLC", "entity_type": "business", "aliases": ["Example Trading"] },
  "articles": [
    {
      "story_key": "s-001",
      "title": "Example Trading LLC faces investigation",
      "url": "https://example.com/story",
      "publisher": "Example News",
      "published_at": "2026-11-20",
      "excerpt": "Authorities opened an investigation into Example Trading LLC.",
      "text": "Full verified article text, when available."
    }
  ]
}
```

Example response:

```json
{
  "contract": "advance-article-screening-v1",
  "model": "jev-1.14.0",
  "event_register": {
    "articles": [
      { "story_key": "s-001", "adverseness": "adverse", "relationship": "direct" }
    ]
  },
  "redundant": []
}
```

The API returns no other adverseness or relationship labels. Invalid provider answers fail the whole request with `502` and no partial screened register. The response is an evaluation artifact; it does not apply the Advance evidence, identity, policy, report, or PDF rules.

## Access and configuration

The route is disabled unless `ADVERSE_MEDIA_JEV_API_ENABLED=true`. It requires `Authorization: Bearer <ADVERSE_MEDIA_JEV_SCREENING_TOKEN>`, with a configured token of at least 32 characters. The TypeSafe key is server-side: configure the native `adverse-media-jev` integration credential through the existing admin credential path, or set `TYPESAFE_API_KEY` for a local environment. The route does not use a customer API key or change customer entitlements. No key is needed for mocked tests.

Requests have a 320 KiB body cap, a 40-article cap, a 48,000-character text cap per article, and a 20-second timeout per Jev call. Calls are serial. A missing TypeSafe key returns `503`; invalid input returns `400`; an oversized body returns `413`; a provider failure or invalid response returns `502`. Provider error bodies and credentials are not returned.

## Next validation step

When labeled sample event registers are supplied, run them through this endpoint with explicit live-test authorization and a budget. Inspect false `redundant` removals first, then compare all nine allowed label combinations against human labels. Adjust criteria and thresholds in a new versioned contract before connecting the adapter to `assessAdvanceScreening()`.
