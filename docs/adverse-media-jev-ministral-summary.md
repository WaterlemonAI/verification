# Ministral summary pilot for Jev incident reports

The finalized Jev JSON remains the source of truth for retained articles, adverseness, relationship, and incident assignment. Ministral writes only the case overview paragraph displayed by the incident PDF. The integrated test API remains JSON-only.

## Local run

Use a short-lived Mistral Studio API key in `MISTRAL_API_KEY`. Do not write it to this repository or into a command argument. The model is pinned to `ministral-3b-2512` in `lib/adverse-media-jev-ministral-summary.mjs`.

```sh
node scripts/run-adverse-media-jev-ministral-summary.mjs finalized.json summarized.json
node scripts/render-adverse-media-jev-incident-pdf.mjs summarized.json report.pdf
```

The first command writes a copy of the finalized JSON with `report_narrative: { source, summary }`; it never modifies the input. It prints the model, token usage, and a conservative cost estimate based on $0.10 per million input and output tokens. Prompt caching may reduce the billed amount. The second command is optional for visual review.

The prompt contains the subject and up to three headlines and two excerpts from each finalized incident group. It omits provider traces, article bodies, URLs, probability vectors, counts, and API credentials. Mistral's strict JSON schema requires exactly one string field, `theme`. Code adds the verified counts, unassigned count, and test-limit caveat around the theme sentence. Invalid JSON, numeric claims in the theme, an overlong summary, or a provider reference causes the pilot to fail without writing a summarized report.

Review each generated paragraph against the finalized JSON before using it. In particular, check allegation language, incident count, the distinction between grouped and unassigned articles, and any claims about the subject. The PDF renderer does not alter the Jev decisions.
