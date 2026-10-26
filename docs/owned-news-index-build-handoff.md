# AI7 Owned News Index — Build Handoff

> **Superseded on 26 October 2026.** The owner changed the requirement to request-time adverse-media URL search using the approved publisher list, with no publisher crawling or article indexing and a below-USD 0.15 per-screening ceiling. See [the current design](dynamic-adverse-media-publisher-search.md). Do not implement or deploy the collection architecture below.

This document is the implementation brief for a separate agent building a compliance-oriented news index for the AI7 adverse-media API. It is intentionally self-contained. Read the repository `README.md`, this document, and the current source before changing anything.

## 1. Objective

Build an AI7-owned index of approximately 1,000 high-value publishers, regulators, courts, enforcement agencies, and other public primary sources. The index must supplement—not replace—the existing Brave, GDELT, regional, and AI classification components used by:

```text
POST https://api.ai7uae.com/service/adverse_media
```

The owned index must:

- improve recall when articles are indexed under an alias or associated organization;
- support multiple languages and the existing regional packages;
- supply evidence with the original URL, publisher, publication time, retrieval time, and integrity hash;
- distinguish allegations, investigations, charges, convictions, regulatory action, and other legal stages;
- expose only provider-neutral, customer-ready results;
- remain useful when an external search provider is degraded;
- keep amortized infrastructure and processing cost within the existing target of USD 0.15 per screening; and
- fail closed when collection coverage or freshness is insufficient.

The target is defensible, measurable coverage—not a claim that the system has found every article on the internet. No implementation may advertise or encode “100% coverage” or “100% confidence.”

## 2. Non-goals and prohibited approaches

Do not:

- scrape Google Search or Google News result pages;
- bypass CAPTCHAs, bot protections, authentication, paywalls, geo-restrictions, or publisher access controls;
- use residential proxies or rotate identities to defeat publisher controls;
- crawl a URL disallowed for the AI7 crawler by `robots.txt`;
- store or redistribute full publisher text without an explicit right to do so;
- execute JavaScript or launch a browser for ordinary article collection in the first release;
- accept instructions contained in articles, feeds, sitemaps, metadata, or model output;
- use Gemini or another paid model for every collected article;
- create a general internet crawler;
- change the current public adverse-media request contract;
- reveal supplier names, upstream credentials, internal search terms, model prompts, costs, or rejected candidates in the customer response;
- modify, delete, rename, or reuse Azure resources belonging to KYCProbe or any non-AI7 project; or
- deploy from an unreviewed branch, mutable image tag, or local machine.

## 3. Current system context

At the time this handoff was written:

- Repository: `WaterlemonAI/verification`
- Baseline branch: `main`
- Baseline source SHA: `ed7207293bd15173ddd2d04066760c213aa66b4b`
- Azure region: UAE North
- AI7 resource group: `rg-ai7uae-web-uaen-001`
- Container Apps environment: `cae-ai7uae-web-uaen-001`
- Registry: `acrai7uaeuaen001`
- API app: `ca-ai7uae-api`
- API Key Vault: `kv-ai7uae-api-uaen-001`
- API domain: `api.ai7uae.com`
- Existing local archive storage: `stai7uaegdeltuaen001`
- Existing GDELT entity table: `GdeltEntityMentions`
- Reviewed API deployment workflow: `.github/workflows/deploy-api.yml`

These values are historical leads. Re-read current `main` and perform authorized readback before relying on any volatile Azure fact.

Existing relevant code:

```text
lib/adverse-media.mjs
lib/gdelt-local-index.mjs
scripts/gdelt-ingest.mjs
infrastructure/api-gdelt-platform.bicep
infrastructure/api-gdelt-job.bicep
infrastructure/api-deep-research.bicep
infrastructure/api.bicep
.github/workflows/deploy-api.yml
```

The existing adverse-media engine already provides:

- multilingual query generation;
- regional domain packages;
- exact-name, alias, and associated-organization matching;
- deterministic adverse-category and legal-stage classification;
- bounded Gemini entity resolution and evidence review;
- URL canonicalization and deduplication;
- risk scoring and threshold handling;
- provider-neutral public coverage reporting;
- deep-research callbacks; and
- an internal 12-paid-query and USD 0.15 guardrail.

Reuse these contracts. Do not create a separate customer-facing adverse-media route.

## 4. Required architecture

```text
Source-controlled publisher manifests
                │
                ▼
Scheduled discovery job ──► discovery queue
                                  │
                                  ▼
                          event-driven fetch job
                                  │
                                  ▼
                         processing/index queue
                                  │
                                  ▼
                         event-driven index job
                           │              │
                           ▼              ▼
                    metadata tables   private blobs
                           │
                           ▼
                 adverse-media API reader
```

Use three independently permissioned stages:

1. **Discovery** reads publisher manifests, `robots.txt`, RSS/Atom feeds, news sitemaps, and sitemap indexes. It emits unseen article URLs.
2. **Fetch** validates and downloads allowed public pages using strict network, size, type, timeout, and rate limits. It emits normalized extraction work.
3. **Index** extracts metadata, entities, adverse signals, and hashes, then writes the searchable tables and permitted blobs.

Each stage must be idempotent. Reprocessing the same URL or message must not create duplicate articles or mentions.

## 5. New Azure resources only

Create new parameterized Bicep. Suggested files:

```text
infrastructure/api-news-platform.bicep
infrastructure/api-news-jobs.bicep
```

Suggested resource names:

```text
Storage account:          stai7uaenewsuaen001
Discovery identity:       id-ai7uae-news-discovery
Fetch identity:           id-ai7uae-news-fetch
Index identity:           id-ai7uae-news-index
Discovery job:            caj-ai7uae-news-discovery
Fetch job:                caj-ai7uae-news-fetch
Index job:                caj-ai7uae-news-index
ACR repository:           ai7uae-news-index
```

Use the existing AI7 Container Apps environment and ACR only if current source and authorized readback confirm they remain dedicated to AI7. Do not use an asset shared with another project.

Required private storage objects:

```text
Queues
  news-discovery
  news-fetch
  news-process
  news-discovery-deadletter
  news-fetch-deadletter
  news-process-deadletter

Blob containers
  news-normalized
  news-crawl-evidence
  news-licensed-content   # create only if explicitly approved

Tables
  PublisherRegistry
  PublisherFeedState
  NewsArticles
  NewsEntityMentions
  NewsCrawlRuns
  NewsCoverageState
```

Requirements:

- Storage must deny anonymous blob access.
- Use managed identities and least-privilege data-plane roles.
- Discovery may read manifests and write discovery/fetch messages but must not write the article index.
- Fetch may consume fetch messages and write processing messages/evidence but must not manage publisher policy.
- Index may consume processing messages and write article/entity tables.
- The API runtime receives read-only access to the article, entity, and coverage records.
- No storage keys, connection strings, passwords, ACR admin credentials, or service-principal secrets.
- Preserve scale-to-zero and set explicit maximum replicas, CPU, memory, job timeouts, and retry counts.
- Do not add public ingress to ingestion jobs.
- Keep raw request/response bodies and secrets out of Log Analytics.

Any new paid Azure tier, retention commitment, region, private networking cost, or RBAC expansion requires an owner decision before deployment.

## 6. Repository layout to create

Suggested implementation layout:

```text
config/publishers/
  global.json
  gulf-mena.json
  india-south-asia.json
  china-hk-taiwan.json
  russia-cis.json
  usa-canada.json
  anz.json
  europe-africa-latam.json

lib/news-index/
  manifest.mjs
  robots.mjs
  discovery.mjs
  fetch-policy.mjs
  extract.mjs
  deduplicate.mjs
  entities.mjs
  adverse-signals.mjs
  storage.mjs
  coverage.mjs
  reader.mjs

scripts/
  news-validate-manifests.mjs
  news-discover.mjs
  news-fetch.mjs
  news-index.mjs
  news-seed-registry.mjs
  news-coverage-report.mjs

test/
  news-manifest.test.mjs
  news-robots.test.mjs
  news-discovery.test.mjs
  news-fetch-policy.test.mjs
  news-extract.test.mjs
  news-deduplicate.test.mjs
  news-entities.test.mjs
  news-coverage.test.mjs
  news-reader.test.mjs
  adverse-media-owned-index.test.mjs

Dockerfile.news-index
infrastructure/api-news-platform.bicep
infrastructure/api-news-jobs.bicep
.github/workflows/deploy-news-index.yml
```

Do not add credentials, copied publisher content, live customer names, or production response payloads to fixtures.

## 7. Publisher manifest contract

Publisher configuration must be source-controlled and reviewed. One entry per publisher:

```json
{
  "id": "stable-lowercase-id",
  "name": "Publisher display name",
  "primary_domain": "example.com",
  "allowed_domains": ["example.com", "news.example.com"],
  "region": "gulf-mena",
  "countries": ["AE"],
  "languages": ["en", "ar"],
  "source_class": "publisher",
  "tier": "B",
  "reliability_weight": 0.8,
  "feeds": [
    { "type": "rss", "url": "https://example.com/news.rss" },
    { "type": "news_sitemap", "url": "https://example.com/news-sitemap.xml" }
  ],
  "crawl_interval_minutes": 120,
  "maximum_requests_per_minute": 2,
  "maximum_daily_article_fetches": 500,
  "storage_policy": "metadata_excerpt_hash",
  "license_reference": null,
  "enabled": true,
  "reviewed_at": "YYYY-MM-DD",
  "reviewed_by": "human-review-reference"
}
```

Allowed `source_class` values:

```text
official_regulator
court
law_enforcement
government_gazette
wire_service
publisher
investigative_nonprofit
```

Allowed tiers:

- **A:** regulators, courts, enforcement bodies, gazettes, and highly authoritative primary sources.
- **B:** established national, financial, wire, and specialist investigative publishers.
- **C:** reviewed regional or local publishers with relevant original reporting.

Tier is a collection and provenance control; it is not a declaration that every article is true. All adverse evidence remains subject to legal-stage labeling and human review.

Manifest validation must reject:

- non-HTTPS feed URLs;
- IP-address hosts, localhost, link-local, private, reserved, or metadata-service targets;
- wildcard domains;
- duplicate IDs or domains without an explicit exception;
- unknown regions, languages, source classes, tiers, or storage policies;
- reliability weights outside `0..1`;
- unbounded intervals, rates, or daily fetch limits;
- enabled entries without human review metadata; and
- full-content storage without a license reference.

## 8. Initial 1,000-source allocation

Use this as an onboarding target, not an excuse to fill quotas with low-quality sources:

| Group | Target |
|---|---:|
| Global wire, financial, and investigative | 100 |
| Gulf and wider MENA | 140 |
| India and South Asia | 180 |
| China, Hong Kong, and Taiwan | 150 |
| Russia and CIS | 120 |
| USA and Canada | 130 |
| Australia and New Zealand | 70 |
| Europe, Africa, and Latin America | 110 |
| **Total** | **1,000** |

Target composition across the entire registry:

- at least 15% official regulators, courts, enforcement sources, and gazettes;
- at least 35% Tier A or Tier B national, financial, wire, or investigative sources;
- no single country or publisher group should dominate a multilingual region; and
- every configured API language must have meaningful native-language coverage, not only English-language sources about that region.

Do not generate and enable all 1,000 entries automatically. Candidate discovery may be automated, but every enabled publisher requires validation and a human review record.

## 9. Candidate discovery and source acceptance

Create a candidate report using:

- domains observed in the existing GDELT archive over a representative period;
- official regulator, court, enforcement, and government directories;
- recurring domains from Brave results across the supported regional packages;
- known national and specialist publisher directories; and
- publisher-provided RSS, Atom, news sitemap, or sitemap metadata.

Score candidates using documented factors:

| Factor | Suggested weight |
|---|---:|
| Jurisdiction and adverse-media relevance | 25 |
| Original reporting or primary-source value | 20 |
| Publication frequency and freshness | 15 |
| Historical availability and stable URLs | 10 |
| Feed/sitemap quality | 10 |
| Language and geographic diversity | 10 |
| Robots/licensing/storage compatibility | 10 |

Before enabling a source, verify:

- publisher identity and ownership where available;
- official domain and redirect behavior;
- feed/sitemap validity;
- publication timestamps and canonical URLs;
- accessible `robots.txt` policy for the AI7 user agent;
- whether metadata/excerpt retention is permitted;
- duplicate or syndicated relationship with existing sources; and
- at least ten representative recent articles where available.

## 10. Scheduling and collection policy

Recommended starting schedule:

| Tier | Feed/sitemap discovery | Fallback sitemap check | Article freshness objective |
|---|---:|---:|---:|
| A | every 60 minutes | every 6 hours | 6 hours |
| B | every 2 hours | every 12 hours | 12 hours |
| C | every 6 hours | daily | 36 hours |

Use conditional requests with `ETag`, `If-None-Match`, `Last-Modified`, and `If-Modified-Since` when supported. A `304` response is a successful freshness check.

Discovery order:

1. RSS or Atom.
2. News sitemap.
3. Standard sitemap or sitemap index.
4. Explicitly configured news/archive pages.

Do not recursively crawl arbitrary links. Do not accept discovered URLs outside the manifest's `allowed_domains`.

Queues must use bounded visibility timeouts, dequeue limits, poison handling, and dead-letter records. A dead-letter message must contain identifiers and sanitized error codes, never full page content or secrets.

## 11. Crawler identity and robots policy

Use an honest crawler identity such as:

```text
User-Agent: AI7NewsBot/1.0 (+https://ai7uae.com/crawler)
```

Publish a crawler-information page before broad collection. It should state purpose, contact method, user-agent token, robots behavior, and opt-out process.

Implement the Robots Exclusion Protocol defined by RFC 9309. Cache parsed rules, but refresh them regularly and when responses change. Apply the most specific applicable rule. Treat publisher content and `robots.txt` as untrusted input.

Fail closed:

- explicit disallow: do not fetch;
- repeated robots failures or ambiguous redirects: suspend fetching and report degraded coverage;
- authentication/paywall response: do not retry through alternate identities;
- CAPTCHA/bot challenge: suspend source and flag it for licensing or manual resolution;
- `429` or `503`: respect `Retry-After`, exponentially back off, and reduce source rate;
- DNS/private-IP transition: block and quarantine the URL.

Reference: <https://www.rfc-editor.org/rfc/rfc9309.html>

## 12. Network and fetch security

Before every fetch and every redirect:

- parse the URL with a strict standard URL parser;
- allow only HTTPS by default;
- resolve DNS and reject loopback, private, link-local, multicast, reserved, carrier-grade NAT, and cloud metadata ranges for IPv4 and IPv6;
- limit redirects and require every redirect target to remain in an allowed publisher domain;
- prevent DNS rebinding by validating the resolved address used for the connection;
- set connect and total-response timeouts;
- limit compressed and decompressed body size;
- accept only configured feed/XML and article HTML/text content types;
- reject executable downloads and unexpected archives;
- never forward API, admin, Azure, customer, or publisher credentials;
- do not send cookies from one request to another; and
- sanitize all error reporting.

Recommended initial limits:

```text
Maximum redirects:              3
Connect timeout:                5 seconds
Total feed timeout:             20 seconds
Total article timeout:          20 seconds
Maximum feed body:              10 MiB
Maximum article body:           5 MiB
Maximum decompressed expansion: 10x
```

Make limits configuration values with guarded maximums; do not make them unbounded environment variables.

## 13. Extraction and normalization

Prefer structured metadata in this order:

1. schema.org `NewsArticle` or `Article` JSON-LD;
2. Open Graph/article metadata;
3. standard HTML metadata and `<time>` elements;
4. conservative main-content extraction.

Normalize:

- canonical URL;
- publisher and domain;
- title;
- publication and modification timestamps;
- retrieval timestamp;
- author where public;
- language and script;
- permitted excerpt;
- entity mentions;
- deterministic adverse terms and categories;
- content hash; and
- extraction version.

Reject or quarantine records that lack an original URL, title, publisher, or defensible publication/retrieval time.

HTML-decode before matching, strip scripts/styles/navigation, normalize Unicode to NFC, and preserve the original language. Do not translate evidence text during ingestion.

## 14. Storage and copyright policy

Default policy: `metadata_excerpt_hash`.

Persist by default:

- canonical URL;
- publisher/domain;
- title;
- public author and timestamps;
- language/region;
- a short evidence excerpt needed to understand the match;
- extracted entities and adverse signals;
- SHA-256 hash of the normalized extracted content;
- fetch headers needed for incremental collection, such as ETag and Last-Modified;
- retrieval and extraction metadata; and
- source/rights policy identifiers.

Discard the fetched page body after processing unless an explicit license permits retention. Do not create or use `news-licensed-content` until the owner approves the license, retention period, and access policy.

The implementation must expose deletion and publisher-disable procedures. A publisher disable must stop new crawling without silently deleting historical audit evidence. Retention periods for metadata, excerpts, crawl evidence, and deletion tombstones require an owner decision before production deployment.

## 15. Table contracts

### `PublisherRegistry`

```text
PartitionKey: region
RowKey: publisher_id
```

Properties include manifest version, domains, languages, class, tier, weights, enabled state, storage policy, review reference, and timestamps.

### `PublisherFeedState`

```text
PartitionKey: publisher_id
RowKey: SHA-256(feed URL)
```

Properties include URL, type, ETag, Last-Modified, last attempted/successful check, response class, consecutive failures, next eligible check, and watermark.

### `NewsArticles`

```text
PartitionKey: first two hex characters of article_id
RowKey: article_id
article_id: SHA-256(canonical URL)
```

Properties include publisher ID, canonical URL, title, excerpt, language, countries, published/modified/retrieved times, content hash, source class/tier, extraction version, categories, legal-stage hints, and storage policy.

### `NewsEntityMentions`

```text
PartitionKey: first four hex characters of SHA-256(normalized entity)
RowKey: entity hash + reverse timestamp + article_id
```

Properties include normalized entity, display value, entity type, article ID, publisher ID, publication time, language, region, mention source, alias/organization context, and deterministic relevance signals.

The reader must verify the normalized entity value after selecting the hash partition. A prefix collision must never become an entity match.

### `NewsCrawlRuns`

Store bounded operational summaries: run ID, stage, start/end, source counts, response classes, new/updated/duplicate/quarantined counts, bytes, and sanitized error-code totals. Do not store article bodies or customer searches.

### `NewsCoverageState`

Store one current state record per region/language/tier plus a signed or hashed registry version. Include active publishers, healthy publishers, freshness distribution, queue age, last completed discovery/index run, and calculated completeness.

## 16. Deduplication

Apply several layers:

1. canonical URL and redirect destination;
2. normalized title plus publisher and publication date;
3. exact normalized-content SHA-256;
4. near-duplicate fingerprint for syndicated copies.

Retain separate publisher URLs for provenance, but group syndicated articles into one evidence cluster for customer presentation. Prefer the primary or highest-tier original source when it can be determined without guessing. Do not suppress an official source merely because a media copy appeared first.

## 17. Entity and adverse-signal indexing

Ingestion should use deterministic processing first:

- Unicode-aware person and organization patterns;
- names from structured article metadata;
- high-precision title and lead-paragraph extraction;
- regional adverse lexicons already present in `lib/adverse-media.mjs`;
- legal-stage phrases; and
- explicit aliases and organization relationships stated in the evidence.

Do not run Gemini for every article. The owned index should retrieve candidates cheaply; the existing screening-time Gemini component can perform constrained entity resolution and classification on the bounded final candidate set.

Any optional batch model step must:

- run only after deterministic adverse prefiltering;
- use a strict JSON schema with no extra properties;
- treat article content as untrusted quoted data;
- prohibit instructions, prose, advice, credentials, and unsupported facts;
- record model/version and validation status privately;
- never be the sole evidence source; and
- remain inside a documented daily and per-screening cost ceiling.

## 18. API integration contract

Create a reader such as:

```text
lib/news-index/reader.mjs
```

It should accept the internal adverse-media request fields:

```json
{
  "entity_type": "individual",
  "name": "Example Name",
  "aliases": [],
  "transliterations": {},
  "associations": [],
  "countries": [],
  "languages": ["en"],
  "date_from": null,
  "date_to": null,
  "max_results": 20
}
```

It should return the same internal raw-result shape expected by the current normalization pipeline:

```json
{
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "description": "permitted excerpt",
      "published": "2026-01-01T00:00:00Z",
      "meta_url": { "hostname": "publisher.example" },
      "_queryLanguage": "en",
      "_sourceType": "owned_news_index"
    }
  ],
  "complete": true,
  "state": {
    "registry_version": "...",
    "freshness": "..."
  }
}
```

Integrate it as an additional free/local search source in `screenAdverseMedia`. Do not consume the paid-query budget. The existing normalizer, entity matcher, adverse classifier, deduplicator, AI evidence review, risk threshold, and public-result formatter must still run.

Add a provider-neutral public coverage mapping:

```text
internal: owned_news_index
public:   owned_news
```

Do not expose publisher-registry internals, crawl errors, storage names, model telemetry, or supplier configuration.

## 19. Completeness rules

An owned-index lookup may return evidence even when its coverage is incomplete. It may report `complete: true` only when all applicable conditions pass:

- the deployed manifest version matches the indexed coverage version;
- the requested region/language has reached its approved minimum source count;
- Tier A sources have no unresolved collection failure beyond their freshness objective;
- at least 95% of enabled Tier B sources are within their freshness objective;
- at least 90% of enabled Tier C sources are within their freshness objective;
- discovery, fetch, and indexing queues are below the approved maximum age;
- the latest completed discovery and index runs are within schedule; and
- no integrity, schema, or storage incident has placed the index in a degraded state.

If any required condition fails, return `complete: false` with a private diagnostic reason. The customer response must use safe provider-neutral reason codes. Incomplete coverage must keep the overall screening `partial`, `inconclusive`, and `decision_eligible: false` unless the existing overall policy is explicitly and separately changed.

The 95% and 90% thresholds are proposed defaults. Obtain owner approval before making them production policy.

## 20. Health, monitoring, and admin visibility

Create sanitized metrics for:

- active and healthy publishers by region/language/tier;
- feed checks and response classes;
- collection and indexing lag;
- queue depth and oldest-message age;
- articles discovered, fetched, indexed, updated, duplicated, and quarantined;
- robots disallows, paywalls, CAPTCHAs, and permanent suspensions;
- extraction failures by version and publisher;
- bytes downloaded and stored;
- job executions, duration, retries, and terminal status; and
- daily estimated Azure and optional-model cost.

Recommended protected admin read endpoints:

```text
GET /admin/api/news-index/summary
GET /admin/api/news-index/coverage
GET /admin/api/news-index/publishers?region=&language=&status=
GET /admin/api/news-index/runs?stage=&status=
```

Do not add mutation endpoints in the first release. Publisher enablement should remain a reviewed manifest change. Never expose these endpoints publicly or include publisher diagnostics in the customer API.

Alerts should cover stale discovery/index runs, excessive queue age, repeated source failure, dead-letter growth, storage/RBAC denial, abnormal download volume, unexpected cost, and API read failure.

## 21. Cost controls

The owned index is intended to amortize collection cost across screenings. Enforce:

- conditional feed and page requests;
- per-publisher request and daily article caps;
- scale-to-zero jobs;
- low fixed maximum replica counts;
- maximum message attempts and dead-lettering;
- bounded body sizes and timeouts;
- metadata/excerpt storage by default;
- deterministic extraction before paid AI;
- maximum daily optional-model candidates and spend;
- lifecycle policies only after retention approval; and
- a cost report before expansion from 100 to 250 and from 250 to 1,000 sources.

Do not claim the USD 0.15 target from design alone. Calculate monthly fixed cost divided by observed monthly checks, add collection/model variable cost, and retain the calculation as deployment evidence.

## 22. Deployment workflow

Create a dedicated workflow:

```text
.github/workflows/deploy-news-index.yml
```

It must:

1. trigger only for owned-index code, manifests, tests, Dockerfile, Bicep, or the workflow itself;
2. install locked dependencies;
3. validate all publisher manifests;
4. run all repository tests;
5. authenticate through the existing approved GitHub OIDC pattern;
6. build and push an immutable `ai7uae-news-index` image;
7. resolve and deploy only the `@sha256:` digest;
8. build/validate Bicep;
9. run a resource-group `what-if` and fail on unexpected deletion/replacement or unrelated assets;
10. deploy the new platform/jobs only after review;
11. retain source SHA, run/attempt, image digest, deployment outputs, and sanitized validation evidence; and
12. never automatically execute an initial backfill merely because infrastructure was deployed.

Initial registry seeding and backfill must be separate, explicit, bounded workflow inputs. Record manifest version, source count, maximum URLs, maximum bytes, start/end, and terminal status.

API integration must still deploy through `.github/workflows/deploy-api.yml` after the owned index is healthy. Do not combine infrastructure creation and API activation into one irreversible step.

## 23. Required tests

At minimum, cover:

### Manifest and policy

- valid manifests across all regions and languages;
- duplicate IDs/domains;
- invalid or private URLs;
- full-content policy without license;
- invalid tiers, intervals, rates, or review metadata.

### Robots and network safety

- longest-match allow/disallow behavior;
- user-agent-specific and wildcard groups;
- redirects to unapproved/private hosts;
- IPv4 and IPv6 private/link-local/metadata targets;
- DNS rebinding defense;
- timeout, size, compression, and content-type enforcement;
- `429`, `503`, and `Retry-After` handling;
- CAPTCHA/paywall suspension without bypass.

### Discovery and queues

- RSS, Atom, news sitemap, sitemap index, and standard sitemap parsing;
- malformed/oversized XML and entity-expansion protection;
- ETag/Last-Modified handling;
- idempotent URL discovery;
- poison/dead-letter behavior;
- out-of-domain URL rejection.

### Extraction and storage

- JSON-LD, Open Graph, standard metadata, and article extraction;
- Unicode and HTML entity normalization;
- multilingual timestamps and text;
- canonicalization;
- exact and near-duplicate grouping;
- metadata-only body disposal;
- entity partition collision verification;
- idempotent writes.

### API integration

- exact-name, alias, transliteration, and organization-association lookup;
- individual first/last-name safeguards;
- business-name matching;
- date, language, and country filtering;
- no one-token individual noise;
- results still pass through current risk and AI safeguards;
- owned-index failure makes coverage partial without failing the HTTP request;
- internal fields and storage details never appear publicly;
- no additional paid search query; and
- existing API, callback, wrapper, and admin tests remain green.

Use synthetic publishers and fixtures only. Network-dependent live tests must not run in the unit-test suite.

## 24. Rollout plan

### Phase 0 — foundation

- New Bicep, identities, queues, tables, containers, jobs, workflow, tests, and cost/health instrumentation.
- No customer API activation.

### Phase 1 — 100 sources

- Balanced sample across every target region and language.
- At least two successful scheduled cycles and a bounded backfill.
- Review extraction accuracy, source failure, lag, storage, and cost.
- API integration remains behind a server-side feature flag.

### Phase 2 — 250 sources

- Correct defects found in Phase 1.
- Validate queue scaling, deduplication, health thresholds, and publisher disable/deletion procedures.
- Run positive, negative, alias, organization, multilingual, and partial-coverage acceptance cases.

### Phase 3 — 1,000 sources

- Onboard reviewed batches; do not enable unreviewed generated manifests.
- Produce a signed/hashed registry inventory and regional coverage report.
- Complete a burn-in period with no unresolved critical collection, security, or integrity failures.
- Obtain owner approval for production completeness thresholds and retention.

### Phase 4 — API activation

- Merge the owned-index reader and coverage mapping through a separate reviewed PR.
- Deploy the API using its existing digest-pinned workflow.
- Verify Azure revision/digest readback.
- Use temporary customer credentials for a bounded smoke test and revoke them immediately.
- Confirm customer responses contain only permitted evidence and provider-neutral status.

## 25. Definition of done

The project is complete only when:

- 1,000 enabled publishers have valid reviewed manifests;
- the regional/language allocation and minimum official-source representation are met;
- robots, rights/storage policy, and feed/sitemap checks are recorded for every enabled source;
- jobs are digest-pinned, identity-separated, private, bounded, and deployed from the reviewed workflow;
- registry, queues, storage, index, and coverage state are durable and idempotent;
- health and cost reporting are operational;
- dead-letter, publisher-disable, deletion, and rollback procedures are tested;
- all repository and new security/contract tests pass;
- the owned index returns relevant positive evidence and rejects synthetic false positives;
- incomplete freshness produces a partial/inconclusive response;
- no new secrets, credentials, customer data, or copyrighted full text appear in source, logs, artifacts, or public responses;
- measured amortized cost is documented against observed volume;
- final source SHA, workflow run/attempt, artifact, image digest, Azure revision, resource readback, and smoke-test evidence are retained; and
- all temporary test credentials are revoked.

## 26. Owner decisions required before production

The implementing agent must stop and request a decision for:

1. metadata, excerpt, crawl-evidence, and tombstone retention periods;
2. any publisher license that permits full-text retention or redistribution;
3. the production completeness thresholds proposed in section 19;
4. any new paid Azure tier or service;
5. crawl contact information to publish on the AI7 crawler page;
6. the allowed maximum monthly infrastructure/model budget;
7. any new region outside UAE North;
8. any mutation-capable news-index admin endpoint; and
9. any public response-contract change beyond adding the provider-neutral `owned_news` coverage source.

These decisions do not block local implementation, manifest tooling, tests, Bicep validation, or an Azure `what-if`. They block production deployment or policy activation where applicable.

## 27. Handoff commands and evidence expectations

Start with:

```bash
git status --short --branch
git remote -v
git rev-parse HEAD
rg --files
npm test
```

Before an authorized Azure operation:

```bash
az account show --query '{subscription:id,tenant:tenantId,user:user.name}' -o json
```

Use repository workflows for deployment. Do not place Azure tokens, Key Vault values, publisher credentials, signed URLs, or customer payloads in commands or evidence.

Every implementation report must separate:

```text
source written
local tests passed
CI passed
image digest published
Bicep previewed
resources deployed
jobs executed
data indexed
API integrated
live response verified
rollback verified
```

Lower-level evidence does not prove a higher-level outcome.

## 28. External standards and platform references

- Robots Exclusion Protocol: <https://www.rfc-editor.org/rfc/rfc9309.html>
- Google news-sitemap guidance: <https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap>
- Azure Container Apps Jobs: <https://learn.microsoft.com/azure/container-apps/jobs>
- Azure event-driven jobs: <https://learn.microsoft.com/azure/container-apps/tutorial-event-driven-jobs>
- Azure Blob indexing concepts: <https://learn.microsoft.com/azure/search/search-how-to-index-azure-blob-storage>

The first release does not require Azure AI Search. Prefer the proposed Storage Table entity index until measured scale, latency, or query requirements justify a separately approved paid search service.
