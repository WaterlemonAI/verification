# GDELT archive search: measured structure and index design

Research date: 19 November 2026. This is a design and read-only data review of the isolated adverse-media candidate and its UAE North GDELT account. It does not change the production API or archive.

## What is actually stored

- The Blob container `gdelt-archive` holds immutable source-shaped ZIPs at `raw/gkg/YYYY/MM/DD/YYYYMMDDHHMMSS.gkg.csv.zip` and a `state/watermark.json` pointer. The live read found **2,610 distinct ZIPs**, **11.164 GB compressed**, one for each 15-minute interval from 22 October 21:15 UTC to 19 November 01:30 UTC. The watermark's `files_processed: 6235` and `entity_mentions_indexed: 38,742,659` are cumulative writes including 36-hour overlap reprocessing, not counts of unique files or rows.
- The ingestion job parses GKG TSV field 11 (`Persons`) and field 13 (`Organizations`), normalizes each name, hashes it with SHA-256, and writes one Table entity per name/document mention to `GdeltEntityMentions`. It retains a URL, source, title, timestamp, language, matched name and raw themes. It does **not** store article body text. The raw ZIP remains the audit source.
- Current `PartitionKey` is `p-` or `o-` plus the first hex character of the name hash. `RowKey` is `fullNameHash_GKGRecordId`, where the record ID starts with a 14-digit UTC timestamp. API reads use a partition and RowKey range for each normalized name, for both person and organisation kinds. This is an exact-name index, not a scan of all ZIPs at request time.
- One observed row: `PartitionKey=o-9`, `RowKey=9fbf261b…_20261117000000-1018`, `matchedName=microsoft`, `publishedAt=2026-11-17T00:00:00Z`, `source=kcbd.com`, title `United Airlines resolves technology issue that delayed departing flights`. This is a co-mention, not evidence that Microsoft committed wrongdoing. GKG's own [codebook](https://data.gdeltproject.org/documentation/GDELT-Global_Knowledge_Graph_Codebook-V2.pdf) describes entities and themes as document metadata, not a proven relationship or allegation.

## Live read measurements

| Query | Observed result |
| --- | --- |
| Microsoft, 17–18 November | 5,404 matching Table rows; six pages; 942 ms with a warm SDK client. Of those titles, 430 contained the exact word `Microsoft`; this is only a title statistic, not a relevance filter. |
| Donald Trump, 17–18 November | 14,919 matching rows; 3,684 ms in the current local-index function; 308 titles contained the exact full name. |
| Donald Trump, all stored history | Hit `scan_time_limit_exceeded` at 68,465 rows in 15,030 ms; archive search correctly marked incomplete despite the global date watermark. |
| Known Microsoft Table entity | First point read 177 ms including cold credential/client work; five subsequent point reads were 7–14 ms. |

Azure Table has a clustered index only on `PartitionKey` and `RowKey`, and each query response is limited to 1,000 entities or five seconds before continuation. The current row-range query is selective but must still transfer every mention page. More compute or a longer API timeout would postpone the failure rather than make full-history reads millisecond scale. See [Table query design](https://learn.microsoft.com/en-us/azure/storage/tables/table-storage-design-for-query) and [query pagination](https://learn.microsoft.com/en-us/rest/api/storageservices/query-timeout-and-pagination).

## Exact problems to solve

1. **Input-size latency.** A popular name can have tens or hundreds of thousands of mentions. Returning, transferring and Gemini-classifying all of those rows cannot have a fixed millisecond latency. The current API reads every row, then sorts and sends at most 50 candidates to Gemini; `candidate_limit_reached` makes a Safe profile unavailable. Faster storage alone does not resolve that decision gate.
2. **Coverage proof.** A single `coverage_start`/`coverage_end` watermark does not prove every 15-minute source file and every derived row was committed. The current ingester skips a source HTTP 404 and may advance the watermark on later intervals. Today's distinct ZIP count happens to equal the expected interval count, but the software does not enforce that invariant.
3. **Incomplete primary evidence.** GKG supplies metadata and article URLs, not complete article bodies. A title/theme/name co-occurrence cannot prove direct adverse conduct. An index can guarantee retrieval of stored mentions; it cannot guarantee the truth of a Safe/Unsafe business judgment from those fields alone.
4. **Wrong fallback trigger.** In the candidate, any `local.limitReason` causes `archiveMissingWindows()` to treat the full request as a public DOC window. That includes the undated, Azure-only high-volume case. A local scan timeout is a query-capacity problem, not a date-coverage gap; public GDELT must not be used to mask it.

## Recommended shortest path on existing Azure storage

Keep the current raw ZIPs and mention table as the audit source. Add a **versioned, per-entity materialized index** in the same UAE North storage account:

1. At ingestion, deduplicate by `(normalizedNameHash, canonicalURL or GKG record ID)` and write compact entity/time-bucket postings. Record exact mention counts and candidate IDs in `GdeltEntityBucketV2` (partition by full entity hash plus bounded time shard). Keep large posting lists as compressed Blob segments, with checksums and row counts. Do not put an unbounded array in one Table entity.
2. Write an immutable `GdeltIntervalManifestV2` for every expected 15-minute interval: source timestamp and SHA-256, number of parsed records, number of unique name/document postings, index version, and committed status. Reconcile manifests against ZIPs and derived postings. Advance a **contiguous committed watermark** only after both data and manifest verify; do not skip 404s silently.
3. Maintain one small `GdeltEntitySummaryV2` point-readable record for each exact normalized name at a committed snapshot: total and per-period counts, candidate and reviewed counts, duplicate counts, unresolved count, top evidence references, snapshot/version, and coverage proof. Publish the new snapshot only after its bucket and summary writes finish. This changes the API's common path from a many-page scan to concurrent point reads for the supplied name and aliases.
4. Move exhaustive evidence work off the synchronous API path. A background job reads each new posting, deduplicates articles, obtains permitted primary text where available, and records a reproducible direct-subject classification with source references. The summary must count **every unreviewed or context-insufficient item**. A request is Safe only when its source intervals are committed and the relevant evidence set has no adverse or unresolved items under the approved policy. Otherwise return Inconclusive while the work continues; never silently drop rows to produce a fast Safe.
5. For arbitrary historical exports or a new alias without a ready summary, create a resumable background case, return its state promptly, and page the full evidence separately. For an undated request, search all committed Azure history and never call public DOC merely because a local query limit was hit. Reserve public DOC for a genuine requested date gap, under the existing three-attempt rule.

**Performance contract to benchmark, not promise in advance:** warm point-read archive lookup p95 under 250 ms for an already materialized exact name; complete synchronous adverse-media response remains bounded by Brave, Gemini and PDF work. An uncached name, very large evidence set, arbitrary full-row export, or archive backfill is asynchronous. A true guarantee that *every matching article is returned and judged in milliseconds* is not technically attainable with this data volume or source format.

Azure AI Search and Azure Data Explorer can provide alternative indexed query engines, but either still needs ingestion, completeness manifests, evidence adjudication and paging. AI Search currently [lists UAE North as constrained for new service creation](https://learn.microsoft.com/en-us/azure/search/search-region-support); its [query result page limit is 1,000 documents](https://learn.microsoft.com/en-us/azure/search/search-limits-quotas-capacity). The Table/Blob materialization is the shortest path using the deployed storage and identity model.

## Build and acceptance sequence

1. Add V2 interval manifests and a verifier; backfill from the 2,610 distinct ZIPs without changing V1 reads. Fail the build if any interval, digest, or posting count disagrees.
2. Add the V2 entity buckets and summary writer to the ingestion job, using idempotent versioned writes. Backfill and dual-write; compare V2 mention and unique-URL counts to a V1 sample across low-, medium- and high-volume names.
3. Add a V2 reader behind a candidate-only feature flag. Verify zero full-row scans on its common path, exact snapshot/alias semantics, and no public DOC call for a scan-capacity limit.
4. Add a durable evidence-review worker and explicit counts for unreviewed and insufficient-context results. Prove no Safe result while any relevant posting is unreviewed or an interval is missing.
5. Benchmark cold and warm p50/p95/p99 for 50 controlled subjects, including high-volume names and one-year history. Compare retrieved candidate IDs, deduplicated URLs, profile, and coverage to a paged exhaustive reference run. Only switch traffic after parity and rollback checks pass.

Likely code touch points: `scripts/gdelt-ingest.mjs`, `lib/gdelt-local-index.mjs`, `lib/adverse-media.mjs`, `infrastructure/api-gdelt-platform.bicep`, `infrastructure/api-gdelt-job.bicep`, and the GDELT/adverse-media tests. Add `lib/gdelt-index-v2.mjs`, `scripts/gdelt-backfill-v2.mjs`, `scripts/gdelt-index-verify.mjs`, and a background evidence worker with its tests.
