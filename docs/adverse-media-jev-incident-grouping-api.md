# Jev incident grouping API

Status: internal evaluation API, 25 November 2026. It is separate from adverseness/relationship screening and does not change the Advance production pipeline or customer access.

## Purpose

`POST /internal/adverse-media-jev/group-events` assigns the same marker to articles about the **same concrete occurrence or case**. A later report of charges, a judgment, or a response about one fraud can remain `Incident 1`. A separate land dispute becomes `Incident 2`; another fraud involving the same subject becomes a different incident. Shared subject, allegation type, or keywords alone do not make two reports the same event.

The API first asks Jev whether each article describes a specific incident concerning the subject. Articles with no supported incident or insufficient evidence remain `unassigned`. It then compares every eligible pair using Jev's `same | different | inconclusive` Choice. Code, not Jev, creates the incident IDs and display labels.

Example request:

```json
{
  "subject": { "name": "Example Trading LLC", "entity_type": "business", "aliases": [] },
  "articles": [
    { "story_key": "a", "title": "Example Trading fraud investigated", "url": "https://example.com/a", "excerpt": "A specific 2025 invoice fraud was investigated." },
    { "story_key": "b", "title": "Charges filed in Example Trading invoice fraud", "url": "https://example.com/b", "excerpt": "Charges followed the same 2025 invoice fraud investigation." },
    { "story_key": "c", "title": "Example Trading land dispute", "url": "https://example.com/c", "excerpt": "A distinct property ownership dispute began in 2026." }
  ]
}
```

Representative response fields:

```json
{
  "contract": "advance-incident-grouping-v1",
  "model": "jev-1.14.0",
  "incidents": [
    { "incident_id": "inc-...", "incident_label": "Incident 1", "story_keys": ["a", "b"] },
    { "incident_id": "inc-...", "incident_label": "Incident 2", "story_keys": ["c"] }
  ],
  "event_register": { "articles": [
    { "story_key": "a", "incident_id": "inc-...", "incident_label": "Incident 1", "group_status": "grouped" },
    { "story_key": "b", "incident_id": "inc-...", "incident_label": "Incident 1", "group_status": "grouped" },
    { "story_key": "c", "incident_id": "inc-...", "incident_label": "Incident 2", "group_status": "single_article" }
  ] },
  "assignments": [
    { "story_key": "a", "incident_id": "inc-...", "incident_label": "Incident 1", "group_status": "grouped" }
  ],
  "unassigned": [],
  "eligibility_reviews": [],
  "pair_reviews": [],
  "unmerged_same_pairs": [],
  "estimated_input_cost_upper_bound_usd": 0.001
}
```

The example abbreviates the audit arrays and hashes. The actual response marks every input row in `event_register.articles`; an unassigned row has `incident_id: null`, `incident_label: null`, and a reason. It also includes an assignment for each incident-bearing article and the Jev probabilities for every reviewed pair. The `inc-` ID is a hash of the subject name and the first sorted `story_key` in its group. It is deterministic for the same input set; adding an earlier story may change that ID. `Incident 1`, `Incident 2`, etc. are display labels ordered by sorted anchor key, not chronology.

## Decision rules

- A row already tagged `redundant` is unassigned without a Jev call. Other articles are eligible for an incident marker when Jev's `specific_incident` probability is at least 0.80. At or below 0.20 it is `no_specific_incident`, unless its text was truncated; middle values are `incident_inconclusive`. An article with neither excerpt nor text is `insufficient_article_evidence` without a Jev call.
- A pair is `same` only when Jev chooses `same` with probability at least 0.85 and a 0.20 lead over the next choice. `different` requires at least 0.80 and the same lead. Other outputs become `inconclusive`.
- For up to 20 eligible articles, groups merge only if **every** article across the two proposed groups has a `same` pair decision. This avoids a chain of `A≈B`, `B≈C`, `A≠C` collapsing into one incident. A high-scoring pair prevented from merging appears in `unmerged_same_pairs`.
- Above 20 eligible articles, the API tries the largest existing incident first. It compares each new article with that incident's first and latest articles; **both representatives must return `same`** to join a group of two or more. An inconclusive representative comparison is recorded in `grouping_warnings`. If no incident matches but at least one comparison remains inconclusive, the article is unassigned with `incident_match_inconclusive` and possible anchors; it is not declared a new distinct incident. The API stops after a supported match, so this is a provisional grouping rather than proof that no other incident also matches. `grouping_method` reports `representative_pairs`; this method avoids exhaustive quadratic calls and needs a cross-check against human event labels.
- A qualifying article without a confirmed match receives its own `Incident N` with `group_status: single_article`. This is a provisional article-level incident marker; it does not verify an adverse finding or prove that no other report covers the case.

These thresholds are provisional. The endpoint returns an evaluation grouping, not a release-ready event count. It needs labeled fraud, land-dispute, follow-up, roundup, and multilingual cases before the markers can drive policy rules.

## Access and limits

The route shares `ADVERSE_MEDIA_JEV_API_ENABLED=true`, the 32-character-or-longer `ADVERSE_MEDIA_JEV_SCREENING_TOKEN`, and the server-side `adverse-media-jev` TypeSafe credential with the screening route. It is registered separately as `adverse-media-jev-grouping`. No new key is required. It accepts 1–100 articles, with the same subject and article fields as the [screening API](adverse-media-jev-screening-api.md). It has a 320 KiB request-body limit.

For each pair, the TypeSafe state includes the title, URL, publisher, date, excerpt, and first 8,000 characters of article text. `eligibility_reviews.text_truncated` marks longer inputs. The API enforces a $0.20 per-request input-size reservation; up to 20 articles also receive an all-pairs preflight. Calls are serial and provider failures return `502` without a partial incident map. A missing TypeSafe key returns `503`.

A full register with more than 100 articles needs a durable, budgeted bulk job that compares across pages and checkpoints provider answers; calling the endpoint on independent pages would miss cross-page matches. The current source CSV and screening output have not been assigned incident IDs yet.
