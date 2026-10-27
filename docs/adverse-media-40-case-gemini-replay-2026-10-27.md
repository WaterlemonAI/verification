# Adverse-media 40-case saved-evidence Gemini replay — 27 October 2026

## Scope and method

This is an **offline reclassification of previous API responses**, not a fresh screening. I matched the screening IDs recorded in the two prior benchmark reports to 47 public report records, verified each PDF download against its stored SHA-256, and extracted the embedded request and response JSON. Selecting the earliest report per subject yielded 40 distinct public subjects (20 businesses, 20 individuals) and 725 previously returned hits. Raw report JSON and the configured Gemini credential stayed local; no customer key was created.

The new classifier reviewed every saved title and excerpt in batches of at most 15. It returned exactly one of **Adverse Media**, **General News Mentions**, or **No Impact Media** for each hit. Server-side identity and subject-role gates demoted four model-overattributed hits: a Wells Fargo chief's forfeiture, a former Equifax executive's conviction, and two company-level Microsoft incidents mentioned alongside Satya Nadella. Only Adverse Media hits at or above the original request's review threshold contribute to `unsafe`; a case with incomplete source coverage or uncertain classification remains `inconclusive`. `safe` means no qualifying adverse hit in the **retrieved evidence**, not a universal clearance.

The replay made **58 Gemini classification calls**, **zero Brave calls**, **zero GDELT calls**, and **zero new screening requests**. The cost guard reserved **$0.8367 total** (about **$0.0209 per case**) for these Gemini calls. This is a conservative reservation, not a Google invoice; it excludes the earlier search costs and any PDF narrative call. No generic retry loop ran. One isolated malformed-batch fixture confirmed a one-time 15-to-8+7 split under the same lifetime cost guard; the final 40-case replay required no split.

## Aggregate result

| Measure | Result |
| --- | ---: |
| Cases | 40 |
| Previously returned hits | 725 |
| Hits assigned to exactly one bucket | 725 |
| Adverse Media | 552 |
| General News Mentions | 163 |
| No Impact Media | 10 |
| New profile: unsafe | 30 |
| New profile: safe | 2 |
| New profile: inconclusive | 8 |

The prior responses had 32 `high_risk`, three `review_required`, four `inconclusive`, and one `no_material_results` outcomes. The comparison is not a population accuracy estimate: these subjects were selected largely because they have known public adverse records, and the replay cannot recover a source absent from the saved response.

## Case-by-case result

`A/G/N` counts are Adverse Media / General News Mentions / No Impact Media. `Partial` means the revised result cannot support an automated decision. The table is a reclassification of old evidence; it is not a fresh live API response.

| Subject | Type | Prior outcome | A/G/N | Revised profile |
| --- | --- | --- | ---: | --- |
| Barclays Bank PLC | Business | high_risk | 24/1/0 | unsafe |
| Binance Holdings Limited | Business | high_risk | 15/8/2 | inconclusive |
| Canva Pty Ltd | Business | review_required | 3/0/0 | unsafe |
| China Evergrande Group | Business | high_risk | 18/7/0 | unsafe |
| Credit Suisse Group AG | Business | high_risk | 9/6/0 | unsafe |
| Danske Bank A/S | Business | high_risk | 14/1/0 | unsafe |
| Equifax Inc | Business | inconclusive | 9/3/2 | inconclusive |
| Gazprombank Joint Stock Company | Business | review_required | 0/2/0 | safe |
| Glencore plc | Business | high_risk | 13/1/0 | unsafe |
| Luckin Coffee Inc | Business | high_risk | 11/3/0 | unsafe |
| Petróleo Brasileiro S.A. | Business | inconclusive | 11/4/0 | inconclusive |
| PT Dian Swastatika Sentosa Tbk | Business | high_risk | 0/14/0 | inconclusive |
| Signzy | Business | high_risk | 15/9/1 | unsafe |
| Standard Chartered Bank | Business | high_risk | 15/0/0 | unsafe |
| The Boeing Company | Business | high_risk | 17/8/0 | inconclusive |
| The Star Entertainment Group Ltd | Business | high_risk | 9/16/0 | unsafe |
| Theranos Inc | Business | high_risk | 13/12/0 | unsafe |
| Volkswagen AG | Business | high_risk | 17/8/0 | unsafe |
| Wells Fargo & Co | Business | high_risk | 6/18/1 | inconclusive |
| Wirecard AG | Business | high_risk | 14/1/0 | unsafe |
| Alexander Mashinsky | Individual | high_risk | 25/0/0 | unsafe |
| Allen Stanford | Individual | high_risk | 13/2/0 | unsafe |
| Bernard L. Madoff | Individual | high_risk | 7/8/0 | unsafe |
| Caroline Ellison | Individual | high_risk | 23/2/0 | unsafe |
| Changpeng Zhao | Individual | high_risk | 20/2/0 | unsafe |
| Do Kwon | Individual | high_risk | 24/1/0 | unsafe |
| Elizabeth Holmes | Individual | high_risk | 19/6/0 | unsafe |
| Gautam Adani | Individual | high_risk | 25/0/0 | unsafe |
| Hui Ka Yan | Individual | high_risk | 24/1/0 | unsafe |
| Jane Fraser | Individual | no_material_results | 0/0/0 | safe |
| Low Taek Jho | Individual | inconclusive | 15/0/0 | unsafe |
| Martin Shkreli | Individual | high_risk | 24/1/0 | unsafe |
| Najib Razak | Individual | high_risk | 25/0/0 | unsafe |
| Nikhil Wahi | Individual | high_risk | 15/0/0 | unsafe |
| Raj Rajaratnam | Individual | high_risk | 11/4/0 | unsafe |
| Ruja Ignatova | Individual | high_risk | 11/4/0 | unsafe |
| Samuel Bankman-Fried | Individual | high_risk | 24/1/0 | unsafe |
| Satya Nadella | Individual | review_required | 0/8/0 | inconclusive |
| Tim Cook | Individual | high_risk | 1/0/4 | unsafe |
| Trevor Milton | Individual | inconclusive | 13/1/0 | inconclusive |

## Material findings

1. **Direct-attribution control improved.** The Tim Cook deepfake, stalking-victim, and namesake hits were classified outside Adverse Media. One separate CNBC result explicitly reports an allegation about Cook's China-sales statements; that remains an adverse *allegation*. Apple's corporate settlement is not presented as Cook's personal settlement. Two Microsoft security stories that mention Satya Nadella as CEO were demoted from personal adverse findings. Former employee and officer actions were also separated from Equifax and Wells Fargo corporate findings.
2. **Relevant business incidents remained visible.** The MediaNama Signzy customer-data exposure and ASIC Canva infringement notices were placed in Adverse Media. This bucket describes adverse reporting or an incident, not proof of fault or guilt. Other results about third-party incidents and related parties need further editorial review.
3. **The Indonesian issuer stayed inconclusive.** All 14 saved PT Dian Swastatika Sentosa Tbk hits landed in General News Mentions after comparison with the regulator's description of other sanctioned parties. The low-confidence classifications block a safe outcome. The prior secondary headline claiming the issuer itself was fined must not be treated as verified from that headline alone.
4. **A classification-only fix cannot repair missing evidence.** The saved Gazprombank response had only two unsourced review/forum items, which moved to General News Mentions; it would therefore read `safe` under the new bucket rule. The [U.S. Treasury designation of Gazprombank Joint Stock Company](https://home.treasury.gov/news/press-releases/jy2725) was absent from the old retrieved JSON. I added Treasury-domain and sanctions terms to the existing fixed-budget official search query, but **no new search was run in this replay**, so that retrieval change is unverified. Do not treat the old Gazprombank `safe` result as a clearance.
5. **Legal stage still needs source-level review.** Pardon and indictment stories about Trevor Milton, Changpeng Zhao, and Low Taek Jho can mention older convictions or other defendants. A deterministic guard now prevents a company settlement *over an individual's statements* from being labeled that individual's settlement. The broader legal-stage timeline and source conflict resolution remain manual review items before regulated use.

## Local verification and release interpretation

The three-bucket API and PDF contract is implemented locally. `npm test` passed **163/163** tests, including all-hit classification above the old 15-item limit, a bounded malformed-batch split, and role-attribution regressions. A generated three-bucket PDF was rendered and visually checked; all sections and their evidence links were readable. This report **does not establish production deployment or live response quality**. The 40 saved JSON responses support a precise comparison of classification and field completeness; they cannot validate recall, new official-source retrieval, latency of a fresh screening, callback delivery, or actual provider billing. The Gazprombank miss is a concrete reason to keep automated `safe` decisions gated until the revised retrieval is tested with authorized fresh cases and the official-source coverage is explicit to customers.
