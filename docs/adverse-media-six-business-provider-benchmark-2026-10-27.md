# Adverse-media six-business provider benchmark — 27 October 2026

This benchmark ran the updated three-bucket classifier locally against live Brave Search and Gemini. It did **not** call the customer-facing API or change production. Inputs used Search+, English and a regional language, a 65% review threshold, a 90% high threshold, and a 25-result cap. The exact returned evidence and measurements are in [the compact run record](evidence/adverse-media-six-business-provider-runs-2026-10-27.json). No provider credentials are stored there.

| Subject | Seconds | Adverse | General | No impact | Brave / Gemini calls | Provider cost ceiling | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| PT Petrindo Jaya Kreasi Tbk | 31.0 | 4 | 21 | 0 | 12 / 2 | $0.0883 | Partial, inconclusive |
| PT Dian Swastatika Sentosa Tbk | 35.8 | 5 | 20 | 0 | 12 / 2 | $0.0880 | Partial, inconclusive |
| PT Barito Renewables Energy Tbk | 31.7 | 15 | 0 | 0 | 12 / 1 | $0.0746 | Partial, inconclusive |
| Signzy | 17.6 | 5 | 19 | 0 | 12 / 2 | $0.0888 | Partial, inconclusive |
| eMudhra | 33.7 | 24 | 1 | 0 | 12 / 2 | $0.0893 | Partial, inconclusive |
| Smilesville Trading | 28.5 | 0 | 0 | 5 | 12 / 1 | $0.0730 | Partial, inconclusive |

Mean latency was **29.7 seconds** (range 17.6–35.8). Across the six runs there were 72 Brave calls, 10 Gemini calls, and $0.5020 total reserved provider-cost ceiling. Each run stayed below the $0.14 per-screening provider guard. All six completed 6 publisher-query batches (60 publisher domains attempted per subject). These are indexed queries, not proof that every article at those publishers was read. The benchmark did not produce a completed or decision-eligible screening because the local index was not configured in this harness and the hosted archive was unavailable. The open-web and publisher searches completed; this is an archive coverage failure, not a Brave or Gemini failure.

## Evidence assessment

- **Petrindo, Dian Swastatika, and Barito Renewables:** Relevant Indonesian market-enforcement coverage was retrieved. However, the classifier marked some secondary headlines as direct regulatory actions against each issuer. [OJK's primary release](https://ojk.go.id/id/berita-dan-kegiatan/siaran-pers/Pages/OJK-Putuskan-Sanksi-Pihak-Terkait-Emiten-DSSA-BREN-dan-CUAN.aspx) says it fined **parties involved in transactions or allocations of those issuers' shares**. The current summaries saying the issuers themselves were fined are therefore unsupported by that release. Barito is the clearest failure: all 15 returned hits were placed in Adverse Media and several were described as direct issuer fines. This is a material attribution error. The product must compare secondary claims with official named parties before promoting them to direct action, and must distinguish issuer, controller, broker, shareholder, and related party.
- **Signzy:** The previously missed [MediaNama customer-data incident](https://www.medianama.com/2024/12/223-signzy-customer-data-leak-exposes-growing-cybersecurity-gaps-in-india/) was retrieved and classified as adverse. Other results repeat the same incident as background; the API currently counts these as separate adverse items. Event-level clustering is needed so one incident is not inflated into multiple findings.
- **eMudhra:** The certificate security incident was retrieved extensively. Several returned article titles and generated assessments call it a data leak or customer-data breach. [eMudhra's incident statement](https://emudhra.com/en/post/certificate-security-incident) says the problem involved weak intermediate CA keys and says its investigation found no infrastructure or customer-data compromise; [CERT-In's advisory](https://www.cert-in.org.in/s2cMainServlet?CACODE=CICA-2026-3649&pageid=PUBADV01) describes the compromised CA certificates and distinguishes the unaffected digital-signature service. The adverse event is real, but the customer-facing summary must accurately describe its scope and uncertainty.
- **Smilesville Trading:** No attributable adverse result was found. Five unrelated generic trading/enforcement pages were correctly kept out of the adverse bucket as No Impact Media. The run remains inconclusive because archive coverage failed; it must not be called Safe.

## Release decision

Keep PR #94 as a draft. The three-bucket contract and adverse-only profile gate work, and the six cases stayed within the provider-cost guard. This benchmark does **not** establish screening accuracy or production readiness. Before release: restore reliable archive coverage; add official-source party attribution for regulatory actions; prevent unsupported breach wording; cluster repeated articles into incidents; rerun these six and the saved 40-case set. A completed result with no adverse hits should only be considered safe after those coverage and attribution checks pass.
