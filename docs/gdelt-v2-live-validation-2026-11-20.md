# GDELT V2 live validation — 20 November 2026

## Scope and isolation

The production API and scheduled GDELT jobs still use their prior image digests. The V2 read and scheduled dual-write flags remain off. Two V2 tables were created with the tables-only Bicep template, whose preview contained exactly those two `Create` operations. Controlled API requests ran inside the internal-only `ca-ai7uae-adverse-candidate` app with live Brave, Gemini, Azure archive and public GDELT access. The QA runner used an ephemeral in-memory workspace and report store, with no customer billing or public endpoint. The candidate was returned to zero minimum replicas afterward.

The existing V1 watermark read from Azure covered 22 October 2026 21:15 UTC through 20 November 2026 01:30 UTC. This is about four weeks of stored history, not a year. Its most recent successful ingestion was 20 November 2026 01:41:44 UTC. A successful source check is not a claim that every article was adjudicated.

## Real API cases

All nine requests returned HTTP 200 and produced a valid PDF header. Detailed sanitized results, source statuses, response hashes, PDF hashes and provider metrics are in [the eight-case JSON evidence](gdelt-v2-live-results-2026-11-20.json) and [the Masdar JSON evidence](gdelt-v2-masdar-live-2026-11-20.json). The PDF and full raw JSON bodies were not retained by this in-memory runner; the hashes demonstrate what was generated during the run, not durable artifacts.

| Case | Subject and route | Profile | Archive | Rows / scan | Total | Finding |
| --- | --- | --- | --- | ---: | ---: | --- |
| 1 | DP World, standard, 16–18 Nov | Inconclusive | Local complete | 0 / 62 ms | 8.1 s | Two unresolved classifications. |
| 2 | DP World, Search+, 16–18 Nov | Inconclusive | Local complete | 0 / 15 ms | 5.5 s | One unresolved classification; Search+ made ten Brave calls. |
| 3 | Emirates NBD, Search+, 16–18 Nov | Inconclusive | Local complete | 0 / 20 ms | 9.6 s | Two unresolved classifications and partial Gemini classification. |
| 4 | Etihad Airways, standard, 16–18 Nov | Safe | Local complete | 33 / 37 ms | 16.2 s | No confirmed adverse article; no unresolved result. |
| 5 | Emaar Properties, standard, 16–18 Nov | Safe | Local complete | 3 / 89 ms | 4.6 s | No confirmed adverse article; no unresolved result. |
| 6 | Microsoft, standard, undated | Unsafe | Local complete | 29,960 / 5.5 s | 119.7 s | Two confirmed adverse articles; 17 unresolved results remain. |
| 7 | Donald Trump, standard, undated | Unsafe | Local partial | 67,562 / 15.0 s | 253.8 s | V1 scan time cap reproduced; two confirmed adverse articles still force Unsafe. No public DOC fallback for an undated Azure-only request. |
| 8 | DP World, standard, 21–23 Oct | Inconclusive | Local plus public incomplete | 0 / 81 ms | 57.7 s | The missing 21–22 Oct period caused exactly three public DOC attempts, all HTTP 429. |
| 9 | Masdar, standard, 16–18 Nov | Safe | Local complete | 0 / 97 ms | 3.7 s | No retained adverse candidate; no unresolved result. |

The nine requests made an estimated **USD 0.298** in variable provider calls, excluding the Azure job and storage charges. This is a small diagnostic cohort, not a latency distribution or evidence of production p95. Search+ made additional publisher queries; it was not reduced to a single Brave call per language.

## V2 storage proof

- Isolated execution `caj-ai7uae-gdelt-ingest-6tm2dta` rebuilt one stored interval at 20 November 01:30 UTC. Independent execution `caj-ai7uae-gdelt-ingest-c7p0npi` verified its ZIP, manifest, V1 sample postings and summary bits for **6,869 mentions**.
- The first historical batch, `caj-ai7uae-gdelt-ingest-duj50di`, checkpointed ten adjacent intervals from 22 October 21:15 through 23:30 UTC. Execution `caj-ai7uae-gdelt-ingest-r2uh6up` independently verified all ten against raw ZIPs and V1 samples: **89,203 mentions**.
- A second ten-interval batch (`caj-ai7uae-gdelt-ingest-7iptmb3`) advanced the contiguous rebuild cursor to 23 October 02:00 UTC. Its independent verifier (`caj-ai7uae-gdelt-ingest-py614l2`) succeeded. The cursor has `cursor_version=2` and records both ends of the completed segment, avoiding a legacy high-water-only checkpoint that could falsely skip history.
- The first batch took 3 minutes 47 seconds including job startup at 0.5 CPU and 1 GiB. The second took 2 minutes 6 seconds at 2 CPU, 4 GiB and bounded concurrency 64. This is a small, non-equivalent sample; it suggests an improvement but does not prove throughput across the archive. The full V1 range contains **2,706 intervals**, of which twenty historical intervals plus the separate latest interval were verified in this run. The V2 index is not yet ready for all-stored-history reads; a measured full rebuild remains required.
- Read-only execution `caj-ai7uae-gdelt-ingest-i8mvc6v` performed two V2 point reads per subject against the partial summary. Observed per-name lookup times were **7–47 ms**: Microsoft 8 ms with 83 partial mentions and Donald Trump 9 ms with 1,643 partial mentions. Every one of those mentions remained unreviewed. The V2 watermark still covered only the separately verified latest interval, so these fast counts must **not** be interpreted as complete history or a finished screening. [Point-read evidence](gdelt-v2-point-probe-2026-11-20.json).

## Release gaps

1. **Historical parity:** finish the resumable V2 rebuild across every V1 interval; independently verify all manifests and compare V2 and paged V1 counts for at least 50 controlled names, including high-volume names. The V2 read flag stays off until its verified watermark covers the fresh V1 watermark.
2. **Article adjudication:** the V2 summary stores at most 20 example references per entity and counts every GKG mention as unreviewed. GKG metadata does not contain full article text. Build a licensed, resumable full-evidence review worker and reconciliation before claiming Safe for a nonempty unreviewed archive. Keep such results Inconclusive until that is done.
3. **Evidence access:** add authenticated paged export of underlying postings and review decisions. The summary must never stand in for the complete evidence set.
4. **History gap and public 429:** the archive still starts on 22 October. The weekly backfill must extend it; three failed public calls remain a real coverage gap. Respecting `Retry-After` already exists, but public availability cannot be guaranteed by extra retries.
5. **Latency and cost:** benchmark warm/cold V2 point reads and full API p50/p95/p99 after parity. The current API also spends time classifying up to 50 candidates and generating the PDF; an indexed archive lookup does not make full screening millisecond-scale.
6. **Release controls:** preserve separate V2 write/read flags, image SHA binding, minimal table-only provisioning, cache invalidation on watermark changes, and rollback to V1. Do not publish V2 reads or call the architecture release-ready while these gates are open.

The exact source file map and release sequence are in [the implementation plan](gdelt-summary-v2-implementation.md).
