# Adverse Media predeployment: 50 end-to-end API runs

Observed 19 November 2026, 08:33 UTC. Source: `codex/adverse-media-one-year-default` at `67a3398`. The updated HTTP server ran locally. It used live Brave Search and Gemini credentials held in process memory, and a read-only snapshot from 50 executions of the exact staged Azure archive lookup against the live UAE North Table and Blob account. The snapshot was captured inside the existing API container; each HTTP request consumed its corresponding snapshot. PDF and JSON retention used the local in-memory test stores. **This was not a live deployment or a full production-network latency test.** No production configuration, data, or image was changed.

The [per-case CSV](adverse-media-predeploy-50-cases-2026-11-19.csv) contains each request's status, coverage, provider calls and token counts, PDF size and integrity, timings, and itemized USD cost model. It contains no provider credentials, article text, or customer documents.

## Outcomes

| Measure | Result |
| --- | ---: |
| HTTP 200 | 50 / 50 |
| Valid downloadable PDF with matching SHA-256 | 50 / 50 |
| Brave requests / non-200 responses | 230 / 0 |
| Gemini requests / non-200 responses | 39 / 0 |
| Gemini classification / PDF narrative requests | 33 / 6 |
| Completed report finalizations / cache hits | 50 / 0 |
| Hosted public-archive attempts / failed Brave queries | 0 / 0 |
| Azure archive ranges fully covered | 25 / 50 |
| Completed, decision-eligible screenings | 16 / 50 |
| Partial, decision-ineligible screenings | 34 / 50 |
| Covered archive but partial after adjudication | 9 / 50 |

The 25 deliberately historical ranges begin before the stored archive coverage and correctly returned `local_index_partial` / `requested_window_not_covered`. The three original subjects were included with their previous older start dates and with a covered recent range. No public GDELT DOC call occurred. Nine covered-range cases remained partial because classification/adjudication required review; the five Search+ cases comprised two completed and three partial. HTTP success does not imply a completed due-diligence decision.

## Performance

Milliseconds, except PDF size. Percentiles use linear interpolation between sorted observations. The API timing is local `POST` response time with live Brave and Gemini and a previously captured Azure archive result; it omits live Table network time on the request path. Archive scan time is measured inside Azure. PDF render time is a separate replay of the same renderer with a deterministic narrative, not an isolated span from the original request. Provider timings are per outbound call, while API timings are per screening.

| Measure | p50 | p90 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| API `POST` | 3,141 | 6,232 | 6,928 | 8,866 | 10,502 |
| Azure archive scan | 20 | 74 | 94 | 123 | 128 |
| Brave call | 748 | 1,202 | 1,263 | — | — |
| Gemini call | 2,005 | 2,566 | 2,639 | — | — |
| PDF render replay | 806 | 2,179 | 3,335 | 5,052 | 6,130 |
| PDF download | 13 | 75 | 152 | 311 | 404 |
| PDF bytes | 1.252 MB | 1.266 MB | 1.267 MB | 8.319 MB | 15.092 MB |

The 15.092 MB, seven-page outlier was case 31. Its visible evidence contained CJK characters, which made the current renderer embed the full CJK OpenType font. A trial of the PDF library's CJK subsetting reduced the file to 109 KB but produced an invalid embedded-font warning during rendering, so that trial was reverted. The reviewed branch retains the valid full-font behavior. A compatible CJK subsetting strategy would reduce PDF size and render time; its output must be checked in multiple PDF readers before release.

## Cost model

These are **estimates, not provider invoices or customer prices**. Brave calls and Gemini input/output tokens were counted from actual provider responses. All 39 Gemini responses supplied usage metadata. The rates used are [Brave Search at $5 per 1,000 requests](https://brave.com/search/api/) and [Gemini 3.5 Flash-Lite standard at $0.30 / million input tokens and $2.50 / million output tokens](https://ai.google.dev/gemini-api/docs/pricing). Azure active compute uses the current [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) UAE North rates of $0.000024 per vCPU-second and $0.000003 per GiB-second, applied to the live app's 0.5 vCPU / 1 GiB allocation and the **local** API timing. That is a sizing model, not a measured Azure charge. PDF storage uses the current UAE North Hot LRS first-tier $0.020275 / GB-month plus an assumed $0.06 / 10,000 write operations, projected for the first year only. Permanent retention incurs continuing storage cost. Azure free grants, credits, negotiated rates, taxes, Table transactions, logging, and shared idle infrastructure are excluded.

| Component, 50 runs | USD |
| --- | ---: |
| Brave Search, 230 calls | 1.150000 |
| Gemini classification, 33 calls | 0.047186 |
| Gemini PDF narrative, 6 calls | 0.005634 |
| Azure API active-compute model, including PDF rendering | 0.002768 |
| PDF first-year storage and write model, 76.593 MB | 0.018935 |
| **Modeled variable total** | **1.224523** |

Modeled per-screening average: **$0.02449**. Per-screening cost percentiles: p50 **$0.02114**, p90 **$0.02871**, p95 **$0.05179**, p99 **$0.05245**, maximum **$0.05287**. The PDF renderer has no separate third-party fee; its approximate compute share is included in API active compute. In this local test, PDF and JSON storage incurred no Azure write or retention charge. The 50 read-only Azure archive lookups incurred shared Azure operations that cannot be reliably isolated from the posted invoice.

The application reserved a maximum of **$0.070223** for providers in any one case, below its **$0.14** provider ceiling. Reservation is a conservative guard value; it is not the token-based cost estimate or a provider invoice. No run used the process cache.

## Release interpretation

This run supports the updated route, provider, archive-status, and PDF contracts under controlled conditions. It does **not** establish a production p95, guarantee screening accuracy, or validate the updated source as a deployed Container App revision. Before promotion, run an authenticated case through a zero-traffic or staged revision using live Azure Table reads in the same request path, then compare its source SHA, provider telemetry, report digest, and latency to this baseline. Keep historical out-of-coverage requests and AI-uncertain results decision-ineligible. The CJK PDF outlier should be reviewed against the product's size and latency targets.
