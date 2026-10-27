# Adverse-media configuration benchmark — 27 October 2026

## Design

Twenty *new* public subjects: ten organizations and ten people. Configurations vary Search+, country and language scope, explicit aliases, a recent-only window, result limit, and thresholds. Four subjects will also be repeated with Search+ toggled to isolate its effect. Every returned hit will be checked for direct subject attribution, legal stage, evidence assessment, date, and primary-source rank. Official and subject-owned references define expected context; a person or company appearing in another party's case is not proof of their own misconduct. Neutral controls have a verified identity, not a guarantee that no adverse information exists.

The fixed comparison inputs are a 15-hit limit and 90% high / 65% review thresholds unless a case says otherwise. Fifteen is the current AI classification cap. This benchmark tests whether that configuration yields more actionable results; it does not establish population-wide accuracy.

| ID | Subject | Type | Main configuration | Expected reference or control |
| --- | --- | --- | --- | --- |
| E01 | Danske Bank A/S | Business | DK; en; Search+; 15 hits | [DOJ guilty plea](https://www.justice.gov/archives/opa/pr/danske-bank-pleads-guilty-fraud-us-banks-multi-billion-dollar-scheme-access-us-financial). Direct corporate action. Danish is not selectable in the current tester. |
| E02 | Glencore plc | Business | CH; en; Search+ off; alias Glencore International AG; 15 hits | [DOJ guilty pleas by Glencore entities](https://www.justice.gov/usao-sdny/pr/glencore-entered-guilty-pleas-foreign-bribery-and-market-manipulation-conspiracies). Distinguish parent and legal entity. |
| E03 | Standard Chartered Bank | Business | GB; en; Search+; alias SCB; 15 hits | [DOJ sanctions resolution](https://www.justice.gov/archives/opa/pr/standard-chartered-bank-admits-illegally-processing-transactions-violation-iranian-sanctions). |
| E04 | Equifax Inc | Business | US; en; Search+ off; date from 2019-01-01; 15 hits | [FTC breach settlement](https://www.ftc.gov/news-events/news/press-releases/2019/07/equifax-pay-575-million-part-settlement-ftc-cfpb-states-related-2017-data-breach). |
| E05 | Credit Suisse Group AG | Business | CH; en,de; Search+; alias Credit Suisse Services AG; 15 hits | [DOJ 2025 subsidiary plea](https://www.justice.gov/opa/pr/credit-suisse-services-ag-admits-conspiring-us-taxpayers-hide-assets-and-income-offshore). Distinguish parent and subsidiary. |
| E06 | Wirecard AG | Business | DE; en,de; Search+; 15 hits | [BaFin regulatory action](https://www.bafin.de/SharedDocs/Veroeffentlichungen/DE/Massnahmen/40c_neu_124_WpHG/meldung_200729_wirecard_ag_zwangsgeldandrohung.html). |
| E07 | Petróleo Brasileiro S.A. | Business | BR; en,pt; Search+; alias Petrobras; 15 hits | [DOJ FCPA resolution](https://www.justice.gov/archives/opa/pr/petr-leo-brasileiro-sa-petrobras-agrees-pay-more-850-million-fcpa-violations). |
| E08 | Luckin Coffee Inc | Business | CN; en,zh; Search+ off; 15 hits | [SEC accounting-fraud settlement](https://www.sec.gov/enforcement-litigation/litigation-releases/lr-24987). |
| E09 | Canva Pty Ltd | Business | AU; en; Search+; 15 hits; 95% high / 70% review | [Official company profile](https://www.canva.com/about/). Neutral identity control; inspect any adverse lead on its merits. |
| E10 | Gazprombank Joint Stock Company | Business | RU; en,ru; Search+; alias Газпромбанк; 15 hits | [U.S. Treasury designation](https://home.treasury.gov/news/press-releases/jy2725). Sanctions lead, not a conviction. |
| P01 | Bernard L. Madoff | Individual | US; en; Search+ off; alias Bernie Madoff; 15 hits | [DOJ case and sentencing](https://www.justice.gov/usao-sdny/programs/victim-witness-services/united-states-v-bernard-l-madoff-and-related-cases). |
| P02 | Allen Stanford | Individual | US; en; Search+; alias R. Allen Stanford; 15 hits | [DOJ sentencing](https://www.justice.gov/archives/opa/pr/allen-stanford-sentenced-110-years-prison-orchestrating-7-billion-investment-fraud-scheme). |
| P03 | Ruja Ignatova | Individual | BG; en,de; Search+; aliases CryptoQueen, Dr. Ruja Ignatova; 15 hits | [FBI wanted profile](https://www.fbi.gov/wanted/topten/ruja-ignatova/download.pdf). Charged and wanted, not convicted. |
| P04 | Low Taek Jho | Individual | MY; en; Search+; alias Jho Low; 15 hits | [DOJ indictment](https://www.justice.gov/usao-edny/pr/malaysian-financier-low-taek-jho-aka-jho-low-and-former-banker-ng-chong-hwa-aka-roger). |
| P05 | Trevor Milton | Individual | US; en; Search+; date from 2025-01-01; 15 hits | [Official 2025 pardon](https://www.justice.gov/pardon/media/1395001/dl). Later disposition must be visible alongside prior conviction. |
| P06 | Raj Rajaratnam | Individual | US; en; Search+ off; 15 hits | [DOJ sentencing](https://www.justice.gov/archive/usao/nys/pressreleases/October11/rajaratnamrajsentencingpr.pdf). |
| P07 | Nikhil Wahi | Individual | US; en; Search+; 15 hits | [DOJ sentencing](https://www.justice.gov/usao-sdny/pr/defendant-sentenced-groundbreaking-cryptocurrency-insider-trading-case). Distinguish from brother and Coinbase. |
| P08 | Satya Nadella | Individual | US; en; Search+; 15 hits; 95% high / 70% review | [Microsoft director/officer profile](https://www.microsoft.com/investor/reports/ar26/index.html). Check for attribution of Microsoft matters to the person. |
| P09 | Jane Fraser | Individual | US; en; Search+ off; 15 hits | [Citi leadership profile](https://www.citigroup.com/global/about-us/leadership/jane-fraser). Check for attribution of Citi matters to the person. |
| P10 | Tim Cook | Individual | US; en; Search+; 15 hits | [Apple leadership profile](https://www.apple.com/leadership/tim-cook/). Check for attribution of Apple matters to the person; current role is Executive Chair. |

Paired repeats: E02, E08, P01, and P09 with the original inputs unchanged except Search+ toggled. Compare primary-reference rank, direct vs related-party hits, empty assessments, latency, paid calls, and estimated cost.

## Live results

The signed-in production tester ran all 20 subjects sequentially on 27 October 2026, followed by four paired Search+ repeats. The first Danske Bank request completed, then a cached repeat captured the detailed UI timing and response fields. These are functional probes of known public subjects, not a sensitivity or specificity estimate for a population. A retained hit is a review lead, not a finding of guilt. All 24 benchmark configurations returned HTTP 200; **four returned `status: partial` and were not decision eligible**.

Across the 20 primary responses, customer-visible time averaged **11.64 seconds** (median **10.72**, observed 95th percentile **20.21**, maximum **30.99**). The cached Danske repeat took 3.96 seconds; its uncached server log took 11.45 seconds, so the primary-run average slightly benefits from caching. The 20 responses contained **239 hits**, of which **15 lacked an evidence assessment** (all in the Jho Low partial run) and **36 lacked a publication date**. Retained source types were 170 open-web, 45 publisher-search, 23 current-news, and **one local archive/GDELT** result. Successful archive lookups therefore added very little evidence in this sample.

| ID | UI time | Status / outcome | Hits | Main observation |
| --- | ---: | --- | ---: | --- |
| E01 | 3.96s cached | Completed / high | 15 | [DOJ corporate guilty plea](https://www.justice.gov/archives/opa/pr/danske-bank-pleads-guilty-fraud-us-banks-multi-billion-dollar-scheme-access-us-financial) ranked 1. Uncached server time was 11.45s. |
| E02 | 10.76s | Completed / high | 14 | Glencore parent, subsidiary and ex-staff events mixed; the exact DOJ reference was absent. |
| E03 | 11.47s | Completed / high | 15 | Relevant sanctions resolution, but the exact DOJ reference was absent; a [NY regulator page](https://www.dfs.ny.gov/reports_and_publications/press_releases/pr1904091) ranked 3 and was labeled `investigation`. |
| E04 | 20.21s | **Partial / inconclusive** | 14 | Archive unavailable. Former employees' insider-trading convictions ranked above the [FTC corporate settlement](https://www.ftc.gov/news-events/news/press-releases/2019/07/equifax-pay-575-million-part-settlement-ftc-cfpb-states-related-2017-data-breach), which ranked 4 and was mislabeled `allegation`. |
| E05 | 12.25s | Completed / high | 15 | [DOJ subsidiary plea](https://www.justice.gov/opa/pr/credit-suisse-services-ag-admits-conspiring-us-taxpayers-hide-assets-and-income-offshore) ranked 1. Parent/subsidiary relationship still needs an explicit label. |
| E06 | 11.25s | Completed / high | 15 | Wirecard evidence found, but the [BaFin action](https://www.bafin.de/SharedDocs/Veroeffentlichungen/DE/Massnahmen/40c_neu_124_WpHG/meldung_200729_wirecard_ag_zwangsgeldandrohung.html) was absent; Wikipedia appeared in the top 3. |
| E07 | 11.79s | **Partial / inconclusive** | 15 | Six paid searches failed across news, web and publisher channels; exact [DOJ Petrobras resolution](https://www.justice.gov/archives/opa/pr/petr-leo-brasileiro-sa-petrobras-agrees-pay-more-850-million-fcpa-violations) absent. |
| E08 | 10.53s | Completed / high | 14 | [SEC Luckin settlement](https://www.sec.gov/enforcement-litigation/litigation-releases/lr-24987) ranked 3; Chinese regulator content ranked 2. |
| E09 | 8.41s | Completed / review | 3 | A real [ASIC filing action](https://www.asic.gov.au/about-asic/news-centre/find-a-media-release/2026-releases/26-090mr-canva-group-pays-792-000-in-infringement-notices-for-failing-to-lodge-financial-reports-on-time) was found, but `convicted` is the wrong legal stage for infringement notices; third-party breach coverage needs role qualification. |
| E10 | 6.56s | Completed / review | 2 | The [Treasury Gazprombank designation](https://home.treasury.gov/news/press-releases/jy2725) was absent. Only low-authority Russian review/forum pages were retained, although official-regulatory coverage was logged complete. |
| P01 | 13.89s | Completed / high | 15 | Madoff [DOJ case](https://www.justice.gov/usao-sdny/programs/victim-witness-services/united-states-v-bernard-l-madoff-and-related-cases) ranked 5. Some hits concerned victims or JPMorgan rather than his own action. |
| P02 | 14.73s | Completed / high | 15 | Stanford [DOJ sentencing](https://www.justice.gov/archives/opa/pr/allen-stanford-sentenced-110-years-prison-orchestrating-7-billion-investment-fraud-scheme) ranked 8; third-party litigation ranked first. |
| P03 | 12.36s | Completed / high | 15 | [FBI wanted/reward news](https://www.fbi.gov/contact-us/field-offices/newyork/news/up-to-5-million-reward-offer-for-information-leading-to-arrest-and-or-conviction-of-ten-most-wanted-fugitive-cryptoqueen-ruja-ignatova) ranked 1. A partner's conviction was also marked `convicted` under Ruja's result. |
| P04 | 8.91s | **Partial / inconclusive** | 15 | Gemini classification failed; all 15 assessments were null. [Jho Low indictment](https://www.justice.gov/usao-edny/pr/malaysian-financier-low-taek-jho-aka-jho-low-and-former-banker-ng-chong-hwa-aka-roger) ranked 4 but was labeled `convicted`. |
| P05 | 30.99s | **Partial / inconclusive** | 14 | Archive unavailable. Pardon stories were retrieved but top entries remained `convicted`; the [official pardon record](https://www.justice.gov/pardon/media/1395001/dl) was absent. |
| P06 | 10.68s | Completed / high | 15 | Raj Rajaratnam [DOJ sentencing](https://www.justice.gov/archive/usao/nys/pressreleases/October11/rajaratnamrajsentencingpr.pdf) ranked 2; first hit concerned his brother Rengan. |
| P07 | 9.61s | Completed / high | 15 | Nikhil Wahi [DOJ sentencing](https://www.justice.gov/usao-sdny/pr/defendant-sentenced-groundbreaking-cryptocurrency-insider-trading-case) ranked 3. |
| P08 | 10.36s | Completed / review | 8 | Microsoft corporate matters and a low-authority blog allegation were attributed to Satya personally. The 95/70 threshold demoted the outcome to review without correcting attribution. |
| P09 | 4.30s | Completed / no material results | 0 | Jane Fraser returned no hits with Search+ off; Search+ on returned six, mainly biographies and workforce stories. |
| P10 | 9.74s | Completed / **high** | 5 | High risk arose from a [deepfake scam impersonating Tim Cook](https://incidentdatabase.ai/cite/786), reports of Cook as a stalking victim, and a [different Tim Cook](https://www.cooley.com/people/timothy-cook). These are clear false positive attribution failures. |

The exact preselected official URL appeared in **9 of 16 positive-reference searches** within the 15 retained hits. This is an exact-URL check: equivalent official pages or credible journalism may have appeared in the other seven. Most concerning misses were E10's Treasury designation and P05's pardon, because they change how a customer should understand the result.

### Search+ paired comparison

Search+ reserves six publisher searches within the fixed paid-query budget; it is not an additive search layer. In this sample, an uncached Search+ run averaged **11 Brave calls and $0.0596 estimated variable provider cost**, versus **5.17 calls and $0.0304** with it off. These are application telemetry estimates, not an invoice or an all-in infrastructure cost. The four paired subjects showed:

| Subject | Search+ off | Search+ on | Assessment |
| --- | --- | --- | --- |
| Glencore | 14 hits, 10.76s | 15 hits, 10.58s | 12 URLs overlapped. Search+ added stories about ex-staff, introducing more attribution work; neither retrieved the exact DOJ reference. |
| Luckin Coffee | 14 hits, 10.53s | 14 hits, 12.69s | Eight URLs overlapped. Search+ added six Chinese-language finance stories, useful for local context, while replacing six other hits. |
| Bernard Madoff | 15 hits, 13.89s | 15 hits, 13.11s | Ten URLs overlapped. Search+ added multilingual obituaries/retrospectives; the main conviction was already found without it. |
| Jane Fraser | 0 hits, 4.30s | 6 hits, 9.14s | Search+ turned a zero-hit response into `review_required`, but the six hits were biographies, workforce coverage and a crypto quote. Two neutral Fortune items were labeled `regulatory_action`; a quote was labeled `charged`. |

Search+ adds regional and publisher breadth, especially useful in the Luckin example, but it currently increases unrelated or low-actionability results for some subjects. The two threshold experiments (95% high / 70% review) moved Canva and Satya to review while retaining 0.90-scored suspect classifications. **Threshold tuning alone cannot repair identity, role, or legal-stage errors.** Explicit aliases helped surface subsidiaries and alternate names, but the response does not consistently distinguish parent, subsidiary, employee, victim or same-name person.

### Provider and coverage telemetry

The isolated 02:40–02:48 UTC telemetry window contained **25 HTTP-200 runs**: the 20 primary subjects, four Search+ comparisons and one cached repeat of E01. It logged **229 Brave calls**, **47 Gemini calls** (classification and report narrative where completed), **zero Brave retries**, **zero hosted-archive retries**, and **$1.2546 estimated variable provider cost**. Each uncached screening stayed at or below **12 Brave calls and two Gemini calls**. The cached repeat made zero Brave calls and one Gemini report-narrative call. Four runs were partial: E04/P05 archive unavailable, E07 six failed Brave searches without retry, and P04 Gemini classification failure. No callback/deep-research worker retries were exercised by this synchronous benchmark; these counts cannot prove that path is safe under failure.

The cost cap prevented runaway calls in this run, but a failed search still consumed an attempted paid call. The median server time was 10.21s and observed p95 was 19.25s across the 25 calls. One local archive result was retained from 239 primary hits. The archived index can be healthy while contributing little to a particular screen; source completion does not establish comprehensive publication coverage.

### Recommended configuration and release implications

1. Use a full legal name, country, relevant search languages and **verified** aliases. Search+ can be enabled when publisher breadth matters, but do not interpret its publisher count as proof that every publisher article was checked. For China, it added useful Chinese context; for the Jane Fraser control, it produced false review leads.
2. Keep `max_results: 15` as an interim setting because the current AI classification batch covers at most 15 hits. Treat it as a cap on returned evidence, not as a guarantee that the most important primary record made the cut. A two-stage retrieval/ranking design is needed before increasing it.
3. Keep the 90% high / 65% review defaults for testing. Higher thresholds reduce alert volume but did not improve factual correctness in the two experiments. Do not call a person or business low risk solely from `no_material_results` until identity and source-coverage checks are stronger.
4. Before bank or regulated-customer use, separate **subject role** (direct actor, corporate affiliate, employee, victim, quoted person, namesake) from **identity match** and **event severity**. Never promote victim, namesake or third-party misconduct to a subject-level high-risk decision. Add explicit legal-stage and later-disposition fields, with primary-source precedence for indictment, settlement, conviction, sanction and pardon.
5. Make official-regulatory retrieval a visible, testable channel for relevant jurisdictions, and expose which databases were queried and whether each returned a match. E10's missing Treasury designation and P05's missing pardon show that a blanket `complete` flag is insufficient. Preserve `partial`/ineligible when a required source or classification fails, and add a controlled retry or deferred completion for the failed component only.

Until the attribution and disposition defects are fixed, these outcomes should be treated as leads for human review. In particular, P10's `high_risk` and P09 Search+ `review_required` are not supportable as subject-adverse determinations from the cited evidence.

### Audit correlation

The production `adverse_media_request_metrics` entries can be retrieved by `screening_id`. The first E01 uncached request was `2331d189-7bd7-45d0-9c2b-c54be8cc52a9`; its cached repeat used `5e4368e4-deb9-43fe-b18d-8505b77fc6de`. No credential or full customer response is stored in this report.

| ID | Screening ID | ID | Screening ID |
| --- | --- | --- | --- |
| E02 | `6f45945e-7dc2-4151-adb4-eaaa92a61f1f` | P02 | `94c2a75f-fa6c-422e-92af-1f31bfbd57c2` |
| E03 | `f693bf77-9349-4257-84d5-115879ab9d4f` | P03 | `5f378305-887f-4fbb-b36a-8eb01e76287f` |
| E04 | `3533b98f-5477-4067-aceb-5bbf57a0e417` | P04 | `d15cf3a2-bde8-479c-b91f-30475f3e7217` |
| E05 | `54601682-db9c-492a-ad14-f63049277126` | P05 | `6e44ca2e-e3a3-4a80-8f9b-171e7b328701` |
| E06 | `0ae74845-d2cb-4d62-b828-2376650d89a8` | P06 | `90a3c5ca-9a2b-4cfd-822d-5be95c4943e0` |
| E07 | `34955f1a-68a8-4f1a-8c21-34d852533ce5` | P07 | `72ff0899-eb3e-404c-a609-87971b43c6cc` |
| E08 | `95c734c2-c2b4-4e8e-8568-41e231ffe2d8` | P08 | `094bf423-4c2d-4447-8bb6-d4556aa11b68` |
| E09 | `b72f7988-c58e-4809-8b7c-fa6899bafaba` | P09 | `79d2b1f3-14fe-4121-bdc4-92d05961faf4` |
| E10 | `f4b0551b-e4f7-4b4d-82c0-45ba5705eb94` | P10 | `4a74745b-6a36-43c5-bf54-3a7f165a1b87` |
| P01 | `63a6045d-f513-4fb5-b435-fd1b0382827a` | E02 Search+ on | `baafa33f-18e5-4f76-8e5a-cd58d51216ac` |
| E08 Search+ on | `10a536ca-2582-4063-8eca-a423f74542bf` | P01 Search+ on | `8cc064a3-860f-4b36-a8e0-52026a4f1ab5` |
| P09 Search+ on | `21d19d5b-cbc7-4abb-8030-93af3a33a2cb` |  |  |
