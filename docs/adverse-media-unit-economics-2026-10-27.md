# Adverse-media unit economics — 27 October 2026

This is a cost model for one **uncached Search+ adverse-media screening with a PDF**. It is not a supplier invoice. The six updated-code provider runs made 12 Brave calls each and one or two Gemini classification calls; they did not render PDFs. A separate request-size replay estimated the maximum token reservation for the PDF narrative. Shared Azure platform cost depends on monthly volume and is shown separately.

| Component | Measured or modeled basis | Estimated USD per check |
| --- | --- | ---: |
| Brave Search | 12 calls × $0.005 per call | **$0.0600** |
| Gemini classification | Six-case mean *reserved upper bound* less Brave: ($0.502021 ÷ 6) − $0.0600 | **≤ $0.0237** |
| Gemini PDF narrative | Six saved responses, exact request bytes and 900-token output cap; five would call the model | **≤ $0.0046** average |
| API container compute | 30 s × (0.25 vCPU × $0.000024/s + 0.5 GiB × $0.000003/s) | **≈ $0.00023** before free grant |
| JSON storage for 365 days | Mean saved input + response 44 KiB; UAE North Hot LRS $0.020275/GB-month plus one write at $0.06/10,000 | **≈ $0.00002** |
| Queue, GDELT lookup, Key Vault, logs, PDF storage | Small marginal usage; shared/fixed charges allocated below | **allow $0.0001–$0.001** |

**Conservative modeled variable ceiling:** about **$0.089 per uncached Search+ PDF check** for the six-case mix. This is a reservation ceiling, so actual Gemini billing should be lower; invoices are needed to establish realized average. A different case may use fewer Brave calls, more evidence, or a different number of Gemini batches. The application provider-cost guard remains **$0.14 per screening**; the additional cloud marginal cost is not included in that guard. Retries and failed provider calls consume the same guard rather than creating an uncapped second allowance.

The 26 October Azure Cost Management readback for this dedicated resource group showed about **$0.193 of posted charges** across ACR, Key Vault, storage and DNS. Container Apps consumption was within the subscription free grant and did not appear as a charge in that readback. Annualized usage and later invoice adjustments are unknown. Using **$6–$12/month** as an illustrative shared fixed-platform allowance (including potential minimum-replica compute after free grant), allocating all of it to adverse media would add about **$0.006–$0.012 at 1,000 checks/month** or **$0.0006–$0.0012 at 10,000 checks/month**. In reality these resources serve other APIs too; allocate by measured workload when invoicing.

The prior 25-call production benchmark recorded $1.2546 in application-estimated variable provider cost across 229 Brave and 47 Gemini calls, or $0.0502 per call. It used an older classifier that assessed only the first 15 results, so it is **not** a price or accuracy estimate for the updated all-results method. The six new runs' provider reservation averaged $0.0837 before the PDF narrative; the six-case request mix is too small to establish a population average.

Pricing references: [Brave Search API](https://brave.com/search/api/) ($5/1,000 searches), [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing) ($0.30/million input tokens, $2.50/million output tokens), [Azure Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing) and the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) queried for UAE North on 27 October 2026. Storage-retention cost assumes the dedicated account's 365-day lifecycle rule, private Hot LRS blobs, no versions or soft-delete copies, and no PDF bytes in the JSON blob.
