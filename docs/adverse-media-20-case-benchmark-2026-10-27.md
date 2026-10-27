# Adverse-media live benchmark — 27 October 2026

## Method

Twenty public-interest subjects: ten organizations and ten people. Every case uses Search+, the subject's country, a relevant language selection, a maximum of 25 results, and the default 65% review / 90% high-risk bands. Public primary records provide the expected lead where possible. A lead may be a conviction, settlement, regulatory action, allegation, or related-party event; finding a document is not a finding of guilt. The browser tester measures customer-visible time; sanitized server metrics record paid search attempts, retries, source completion, AI status, and report time. No names or credentials are written to production telemetry.

This is a retrieval and attribution benchmark, not an estimate of population-wide sensitivity or specificity. The 15-minute cache is avoided by using each subject once. Results are evaluated for source URL, identity match, legal stage, decision eligibility, report URL, language coverage, and presence of the required JSON fields.

| ID | Type | Subject | Country / languages | Expected public lead |
| --- | --- | --- | --- | --- |
| B01 | Business | PT Dian Swastatika Sentosa Tbk | ID / en,id | [OJK action involving trading in DSSA shares](https://ojk.go.id/en/berita-dan-kegiatan/siaran-pers/Pages/OJK-Delivers-Sanction-Letters-to-DSSA-CUAN-BREN.aspx). The sanctioned parties must not be silently attributed to the issuer. |
| B02 | Business | Binance Holdings Limited | US / en | [DOJ corporate guilty plea](https://www.justice.gov/archives/opa/pr/binance-and-ceo-plead-guilty-federal-charges-4b-resolution). |
| B03 | Business | Wells Fargo & Co | US / en | [SEC investor-disclosure settlement](https://www.sec.gov/newsroom/press-releases/2020-38). |
| B04 | Business | Volkswagen AG | DE / en,de | [DOJ emissions-case resolution](https://www.justice.gov/usao-edmi/pr/volkswagen-ag-agrees-plead-guilty-and-pay-43-billion-criminal-and-civil-penalties-and). |
| B05 | Business | The Boeing Company | US / en | [DOJ case docket and later disposition](https://www.justice.gov/criminal/criminal-fraud/case/united-states-v-boeing-company). |
| B06 | Business | Theranos Inc | US / en | [SEC company and officer fraud charges](https://www.sec.gov/newsroom/press-releases/2018-41). |
| B07 | Business | Barclays Bank PLC | GB / en | [FCA financial-crime controls fine](https://www.fca.org.uk/news/press-releases/fca-fines-barclays-42-million-poor-handling-financial-crime-risks). |
| B08 | Business | The Star Entertainment Group Ltd | AU / en | [ASIC proceedings concerning officers](https://asic.gov.au/about-asic/news-centre/find-a-media-release/2022-releases/22-351mr-asic-launches-proceedings-against-11-current-and-former-star-entertainment-directors-and-officers/). Distinguish company from charged officers. |
| B09 | Business | China Evergrande Group | CN / en,zh | [Hong Kong SFC findings on company statements](https://apps.sfc.hk/edistributionWeb/api/news/list-content?lang=EN&refNo=26PR62). |
| B10 | Business | Signzy | IN / en | [MediaNama report of customer-data exposure](https://www.medianama.com/2024/12/223-signzy-customer-data-leak-exposes-growing-cybersecurity-gaps-in-india/). This is adverse reporting, not a regulatory finding. |
| I01 | Individual | Samuel Bankman-Fried | US / en | [DOJ sentencing](https://www.justice.gov/archives/opa/pr/samuel-bankman-fried-sentenced-25-years-his-orchestration-multiple-fraudulent-schemes). |
| I02 | Individual | Elizabeth Holmes | US / en | [DOJ verdict and sentencing record](https://www.justice.gov/usao-ndca/us-v-elizabeth-holmes-et-al). |
| I03 | Individual | Changpeng Zhao | US / en | [DOJ guilty plea](https://www.justice.gov/criminal/case/united-states-v-changpeng-zhao); [2025 pardon](https://www.justice.gov/pardon/media/1416576/dl?inline=) is material later context. |
| I04 | Individual | Do Kwon (alias Do Hyeong Kwon) | KR / en | [DOJ sentencing](https://www.justice.gov/usao-sdny/pr/crypto-enabled-fraudster-sentenced-orchestrating-40-billion-fraud). |
| I05 | Individual | Martin Shkreli | US / en | [DOJ sentencing](https://www.justice.gov/usao-edny/pr/martin-shkreli-sentenced-seven-years-imprisonment-multi-million-dollar-fraud-scheme). |
| I06 | Individual | Gautam Adani | IN / en | [DOJ indictment](https://www.justice.gov/usao-edny/pr/billionaire-chairman-conglomerate-and-seven-other-senior-business-executives-indicted). Allegation, not conviction. |
| I07 | Individual | Caroline Ellison | US / en | [DOJ guilty plea](https://www.justice.gov/usao-sdny/pr/united-states-attorney-announces-extradition-ftx-founder-samuel-bankman-fried-united). |
| I08 | Individual | Alexander Mashinsky (alias Alex Mashinsky) | US / en | [DOJ sentencing](https://www.justice.gov/usao-sdny/pr/founder-celsius-sentenced-12-years-fraud-and-market-manipulation). |
| I09 | Individual | Najib Razak | MY / en | [Malaysian Federal Court judgment](https://www.kehakiman.gov.my/sites/default/files/documents/Ringkasan_Media/2022/Grounds%20of%20Judgment%20-%20Dato%27%20Sri%20Najib%20v%20PP%20%28Appeals%29%20%2823.8.2022%29.pdf). |
| I10 | Individual | Hui Ka Yan (aliases Xu Jiayin, 许家印) | CN / en,zh | [Chinese court first-instance judgment](https://www.court.gov.cn/zixun/xiangqing/509281.html). |

## Results

All 20 requests were sent through the signed-in production tester on revision `df55130cdb4694458ca609d6064ca5c689b5cfc4`. Each used Search+, a country and relevant language, `max_results: 25`, and report generation. Times below are customer-visible submit-to-response times. “Reference rank” is the position of the exact reference URL or distinctive URL slug linked above among the returned hits; zero means that exact page was absent, not that no equivalent story was found. The results are from one sequential run, not a concurrency or population-accuracy test.

| ID | Time (s) | Hits | Reference rank | Empty assessments | Missing dates | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| B01 | 14.08 | 14 | 0; another OJK page ranked 3 | 0 | 2 | completed / high |
| B02 | 12.96 | 25 | 16 | 10 | 3 | completed / high |
| B03 | 14.07 | 25 | 21 | 10 | 0 | completed / high |
| B04 | 13.67 | 25 | 12 | 10 | 0 | completed / high |
| B05 | 12.95 | 25 | 20 | 10 | 2 | completed / high |
| B06 | 12.68 | 25 | 12 | 10 | 1 | completed / high |
| B07 | 11.08 | 25 | 5 | 10 | 7 | completed / high |
| B08 | 11.79 | 25 | 2 | 10 | 6 | completed / high |
| B09 | 12.38 | 25 | 0 | 10 | 2 | completed / high |
| B10 | 9.57 | 25 | 6 | 10 | 9 | completed / high |
| I01 | 13.44 | 25 | 17 | 10 | 3 | completed / high |
| I02 | 13.54 | 25 | 7 | 10 | 1 | completed / high |
| I03 | 10.01 | 22 | 4 | 10 | 1 | completed / high |
| I04 | 12.50 | 25 | 8 | 10 | 0 | completed / high |
| I05 | 11.12 | 25 | 12 | 10 | 2 | completed / high |
| I06 | 11.21 | 25 | 0 | 10 | 0 | completed / high |
| I07 | 10.79 | 25 | 3 | 10 | 2 | completed / high |
| I08 | 10.94 | 25 | 0 | 10 | 4 | completed / high |
| I09 | 12.54 | 25 | 0 | 10 | 1 | completed / high |
| I10 | 11.92 | 25 | 0 | 10 | 3 | completed / high |

### Timing, provider use, and retry evidence

- Customer-visible mean **12.16 s**, median **12.44 s**, 95th percentile **14.07 s**, range **9.57–14.08 s**. Server telemetry mean **11.48 s**, split into **8.11 s** screening and **3.37 s** report generation. Server 95th percentile **12.78 s**. These are descriptive figures for 20 sequential requests.
- The 20 runs made **214 Brave calls** (10–12 per case), **40 Gemini calls** (one classification and one report narrative per case), 20 local GDELT index lookups, and **zero hosted GDELT calls**. Azure logs recorded **zero Brave retries, zero hosted-archive retries, zero failed search queries, and zero failed source channels** in this sample. No evidence here of an active retry storm.
- Provider cost reservations totalled **$1.384** (mean **$0.0692/check**); the estimated variable cost recorded by screening totalled **$1.173** (mean **$0.0586/check**). These are application estimates and reservations, not a reconciled Brave/Google invoice. All were below the configured per-request provider guard. The report-generation Gemini call is visible in the actual provider-call counter.
- A second Signzy request within the cache window returned in **6.28 s** customer-visible / **5.43 s** server time. Its log showed `cache_hit: true`, **0 Brave** and **1 Gemini** call; the Gemini call was the new PDF narrative.
- One additional **deep-research** Signzy submission returned HTTP 202 and produced exactly one final, signed webhook callback with a completed, eligible response and report. Azure logged **one dequeue**, one screening, one report finalization, **10 Brave and 2 Gemini calls**, and no retries. The existing local failure-path suite also passed 27 tests, including a deliberately failing callback that retries delivery without additional Brave calls and moves exhausted jobs to the dead-letter queue. That mock verifies code behavior, not a live failed-callback exercise.

### Source yield and field completeness

- There were **486 returned hits**: 293 `open_web`, 106 `publisher_search`, 86 `news_index`, and **1 `global_news_archive`**. Search+ made 119 publisher-domain query batches across the 20 cases. It reported 60 publisher domains queried for 19 cases and 50 for one. The 1,500-outlet catalog is a selection pool; a request did not search all 1,500 and does not crawl each outlet directly. Publisher batches are domain-restricted Brave searches.
- The local GDELT archive was fresh but its live watermark covered roughly **22–27 October**, only about four days at benchmark time. It returned one retained hit for these mostly historical cases. The sole hit, a [HotAir article about the SPLC and debanking](https://hotair.com/david-strom/2026/10/24/the-hate-map-was-never-a-map-it-was-a-hit-list-washington-used-n3820304), mentions Wells Fargo as one of several banks but was scored **0.92 high risk** for Wells Fargo even though its evidence assessment called the content incoherent. The article's paragraph about banks is not a finding that Wells Fargo committed the misconduct described elsewhere in that article.
- **117** retained links came from government or regulator domains in the sampled set, but all responses said `official_records: not_requested`. That field refers to a dedicated records connector; official pages were retrieved through Brave web/news search. The current source labels do not make this distinction clear to customers.
- Every response contained all expected top-level keys and every hit contained the expected JSON keys. However **190/486 hits (39.1%)** had a null `evidence_assessment`, and **49/486 (10.1%)** had a null `published_at`. The code classifies at most **15 candidates** (`MAX_AI_CANDIDATES`) while returning up to 25. Eighteen cases returned 25 hits and one returned 22; each had ten unassessed hits after scoring and filtering. The remaining 14-hit case had no empty assessments. All still reported `status: completed` and `summary.decision_eligible: true`.
- Exact primary reference pages were present in **14/20** returned sets and in the first ten hits for only **7/20**. They were absent for B01, B09, I06, I08, I09, and I10, though alternate relevant sources appeared. Examples of buried primary pages: Binance DOJ at rank 16, Wells Fargo SEC at 21, Boeing DOJ at 20, and Samuel Bankman-Fried DOJ sentencing at 17. The [exact MediaNama Signzy article](https://www.medianama.com/2024/12/223-signzy-customer-data-leak-exposes-growing-cybersecurity-gaps-in-india/) was present at rank 6.

### Decision-quality defects found

1. **Unassessed hits can be decision eligible.** The AI pass covers only the top 15 pre-filter results. Ten further hits per full response have no assessment, yet the API claims full completion. Either classify all returned hits in bounded batches or clearly mark each unassessed hit and make the whole response ineligible for an automated decision. The current result cap and AI cap must be reconciled.
2. **Contradictory high-risk scoring.** B01's [ordinary IDX disclosure](https://www.idx.co.id/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/From_EREP/202112/85471617de_26d853ab9c.pdf) scored **0.90 high** while its own assessment said it did not describe adverse conduct. The Wells Fargo archive hit above scored **0.92 high** despite a non-adverse assessment. These are confirmed false-positive examples, not merely differing risk opinions. A narrow local regression test now covers the IDX pattern; it is not deployed.
3. **Subject attribution and legal stage are conflated.** High-ranked company results include charges against a Wells Fargo employee, Boeing procurement officer, Star Entertainment officers, and Evergrande's founder. Those can be relevant relationship leads, but should not silently become direct corporate findings. An indictment page for Samuel Bankman-Fried and an indictment page for Martin Shkreli were labeled `convicted`; a Do Kwon guilty-plea story was labeled `media_mention`; a Caroline Ellison sentencing story was labeled `media_mention`; a pardon article for Changpeng Zhao was treated as adverse without a structured later-disposition field. The response needs subject-of-action and disposition extraction, plus conservative stage labels tied to the cited page.
4. **Ranking favors generic or related-party items over definitive primary evidence.** Exact regulator/court pages often appear well below secondary articles, and the 25-hit cap can exclude them. Rank verified direct-subject primary records ahead of same-name mentions, duplicates, officer-only cases, and tangential GDELT hits. Preserve later dispositions such as acquittal, pardon, appeal, and settlement in the same case timeline.
5. **Coverage wording overstates what was checked.** `current_news`, `open_web`, `publisher_search`, and `archive` all said complete in all 20 cases. This means their bounded queries succeeded; it does not mean all publishers, historical media, or official databases were comprehensively screened. The Search+ `publishers_screened` list means domains included in successful Brave queries. Expose searched domain count, query count, archive date range, and dedicated official-connector status separately.

### Release recommendation

Do not use `decision_eligible: true` as an automated banking decision for adverse media until items 1–3 are corrected and retested. The provider and queue containment performed well in this sample; the limiting issue is evidence interpretation and completeness. Add negative and near-name controls, historical cases outside the local archive window, non-English direct-source cases, and a live failure-injection test in an isolated environment before claiming sensitivity or reliable low-risk decisions. No customer identity or API key was written to the benchmark telemetry.

### Production trace IDs

These IDs correlate the table with sanitized `adverse_media_request_metrics` entries in the dedicated Azure Log Analytics workspace. The successful deep-research callback used `7c068701-842c-45a8-b72e-f6084884f8e5` and the cached Signzy repeat used `3e4e6a17-431f-4d31-a6ff-1eaded7481c5`.

| ID | Screening ID | ID | Screening ID |
| --- | --- | --- | --- |
| B01 | `f01a26c7-cc2b-48e8-9ced-2bfdcd191d39` | I01 | `aa05f795-6732-4e37-9bcf-28f38bfd73a4` |
| B02 | `fe2d2fcc-5872-4cac-b2e7-5606496822f5` | I02 | `26aee97d-75fe-4073-991b-56c60af468cd` |
| B03 | `c2db16ec-e8e6-4fb4-bf0e-362833e0950a` | I03 | `2aabf24b-7078-4b4f-9acc-d17977ff19ca` |
| B04 | `46ea2303-4714-4f65-8c9d-118aefdbc99c` | I04 | `9dee434a-e089-42ef-a6c6-19f8bc35ac55` |
| B05 | `74629785-66c1-4338-b08f-a7ebdf51623c` | I05 | `e1a433c8-3fed-49b7-b801-78fdc5ac98de` |
| B06 | `52533a4a-cbd3-40bb-8d3b-1d2164139e0c` | I06 | `4a22e6d6-fb08-477d-8750-261e20aa3398` |
| B07 | `3b1921cf-007a-41af-8ec1-1225f1b45d73` | I07 | `0bcc1e01-90f2-4d8b-9840-ccd1c79d2787` |
| B08 | `a23910bd-f75a-4737-b5b8-5290d1aeb2f7` | I08 | `a666c3b3-9416-4e7a-86f7-b037404e4163` |
| B09 | `d99c5fea-a4f4-45ae-9875-e13c115944af` | I09 | `e22c263b-28e1-48a3-9650-e7f3234c0269` |
| B10 | `7d23fa85-4eac-4827-941a-f1f32df5d662` | I10 | `108d6b56-6a2f-4fa1-aacc-9d2630a9843b` |
