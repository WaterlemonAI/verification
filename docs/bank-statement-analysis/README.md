# Bank Statement Analysis API — MVP Engineering Handoff

Status: design approved for local MVP implementation
Target surface: `api.ai7uae.com`
Primary market: UAE
Processing languages: English and Arabic, including mixed-language statements
Authority boundary: research, design, and local development only; no deployment, production mutation, or merge is authorized by this document

## 1. Purpose

This document is the implementation specification and agent handoff for the Bank Statement Analysis (BSA) API. An implementation agent should be able to use it to plan, build, test, and deliver the local MVP without relying on prior chat history.

The BSA API converts one or more uploaded bank statements into evidence-backed, reconciled cash-flow features suitable for use by banks, credit-card issuers, finance companies, and other approved credit-decisioning systems.

The BSA API is a **decision-support and feature service**, not an autonomous credit-decision engine. It must not approve, decline, price, or set a credit limit by itself. A lender must combine BSA features with its approved credit policy, customer declarations, KYC, credit-bureau information, known liabilities, and human-review controls.

The central engineering requirement is:

> Any bank format may be translated into the canonical ledger, but financial meaning, source evidence, currency, precision, balance direction, ownership, and mathematical reconciliation must never be lost in translation.

## 2. Product objectives

The MVP must:

1. Accept a PDF or supported image bundle containing one or many statements.
2. Split a combined PDF into the correct banks, accounts, statement periods, products, and currencies.
3. Extract text, tables, headers, balances, ownership information, and transaction rows.
4. Normalize bank-specific layouts and terminology into a lossless canonical ledger.
5. Reconcile every account-and-currency ledger independently.
6. Remove duplicates and prevent overlapping statements from double-counting activity.
7. Identify probable self-owned accounts and transfers between them.
8. Identify salary and other recurring income sources, probable employers, changes, gaps, and irregularities.
9. Separate genuine external income from self-transfers, loan proceeds, refunds, reversals, one-offs, and circular funds.
10. Identify circular transactions and low-net-economic-value flows across uploaded accounts.
11. Analyze balances, overdraft use, liquidity, expenses, recurring obligations, cash flow, and multi-currency exposure.
12. Return confidence, coverage, reconciliation, provenance, evidence, and reason codes with every material result.
13. Process financial data using private, tenant-isolated storage and redacted observability.
14. Run and be verifiable locally before any cloud or production work is considered.

## 3. Non-goals for the MVP

The MVP must not:

- make an approval or decline decision;
- generate a probability of default without a lawful, representative, outcome-labeled training set;
- replace an AECB or other required credit-bureau check;
- infer that all credits are income or all debits are expenses;
- treat all circular transfers as fraud;
- attribute joint-account income to an applicant without evidence;
- consolidate different currencies without an explicit reporting rate, source, date, and formula;
- assert document fraud based only on PDF or visual anomalies;
- use a general-purpose LLM or vision-language model to perform arithmetic;
- use transaction descriptions to infer protected or sensitive personal traits;
- allow an OCR confidence score to override failed ledger reconciliation;
- accept remote statement URLs in the MVP;
- make bank statements or derived reports accessible through permanent public capability URLs;
- store real customer statements in source control, test fixtures, model artifacts, logs, or chat;
- deploy, merge, change Azure infrastructure, create secrets, or alter RBAC without separate explicit authority.

## 4. Regulatory and governance context

This is an engineering design, not legal advice. UAE legal and compliance specialists must approve final retention, consent, decisioning, disclosure, and model-governance policies.

The implementation should be designed around the following obligations:

- CBUAE Responsible Financing Practice requires lenders to assess ability to service credit, review sufficient credit history, and document supporting information.
- CBUAE Consumer Protection Standards require prudent treatment of variable income, exclusion of one-off income from affordability, verification of income where reasonably possible, consideration of existing obligations, and documented financing decisions.
- CBUAE Model Management Standards require defined model purpose and usage, documentation, monitoring, independent validation, controlled overrides, and accountable use of third-party models.
- UAE personal-data law gives individuals rights relating to consequential automated processing and requires appropriate controls and, where applicable, human review.
- If the service later consumes UAE Open Finance data directly, licensing, consent, data-residency, record-keeping, and ISO 20022 requirements must be assessed before activation.

The service must therefore return evidence and features in a form that a lender can independently validate. It must not present an extraction model, anomaly detector, or third-party model as a regulatory credit decision.

## 5. Design principles

### 5.1 Evidence before inference

Every normalized value must retain the raw text, source page, bounding coordinates, extraction method, extractor version, normalization rule or model version, and confidence.

### 5.2 Reconciliation before analytics

Analytics may consume only a reconciled ledger, or must clearly state that the ledger is partial or unreconciled. The system must never silently repair unexplained discrepancies.

### 5.3 Per-currency accounting

Reconciliation operates on one account, statement section, ledger type, and currency at a time. Currency conversion is a later reporting operation and never participates in statement reconciliation.

### 5.4 Separate facts from classifications

The system must distinguish:

- observed facts;
- values derived through exact arithmetic;
- deterministic classifications;
- model inferences;
- customer declarations; and
- externally corroborated information.

### 5.5 Confidence cannot manufacture coverage

A high-confidence model result cannot compensate for missing months, missing pages, overlapping periods, an unknown owner, or failed reconciliation.

### 5.6 No floating-point money

All monetary calculations use decimal strings and `decimal.Decimal`, or validated integer minor units. JavaScript `Number` and Python `float` must not be used for financial arithmetic.

### 5.7 Explainable outputs

Every material feature must have a stable definition, formula version, input references, exclusions, confidence, and reason code.

### 5.8 Fail closed

Unsupported formats, ambiguous ownership, missing pages, arithmetic disagreement, and model unavailability produce a partial or inconclusive result requiring review. They must not be converted into a normal completed response.

## 6. High-level architecture

```text
Customer
   |
   v
api.ai7uae.com — existing Node.js API
   |  authenticate, authorize, validate, hash, enqueue
   |  return HTTP 202 + analysisId
   v
Private Blob Storage + Queue + Job Metadata
   |
   v
Private BSA analysis worker — Python
   |
   +-- file validation and malware gate
   +-- PDF page renderer and native-text extractor
   +-- document/page segmenter
   +-- managed Layout extractor or private OCR fallback
   +-- bank format adapters
   +-- canonical ledger builder
   +-- reconciliation and deduplication engine
   +-- ownership and counterparty resolver
   +-- circularity graph engine
   +-- income, employer, obligation, liquidity, and anomaly analysis
   +-- evidence and report generator
   |
   v
Private result artifacts + tenant-scoped authenticated API response
```

### 6.1 Recommended runtime split

Keep the existing public API on Node.js 22. Add a separate Python 3.12 worker for document analysis and numerical processing. Do not add Python, PaddleOCR, ONNX Runtime, or document-processing dependencies to the existing Node API image.

The public API is responsible for:

- Bearer-key authentication;
- server-controlled tenant resolution;
- MIME, signature, size, and request validation;
- SHA-256 content hashing and idempotency;
- encrypted temporary upload storage;
- queue submission;
- authenticated status and result retrieval;
- callback signing, if callbacks are enabled; and
- deletion requests and retention enforcement.

The worker is responsible for all document interpretation and analytics.

## 7. Recommended technology stack

| Capability | MVP technology | Notes |
|---|---|---|
| Public API | Existing Node.js 22 ESM service | Preserve existing authentication and provider-neutral API conventions |
| Worker | Python 3.12 | Separate image/container and identity |
| Contracts | Pydantic v2 + generated JSON Schema | Version every canonical contract |
| Worker mode | Queue-triggered Azure Container Apps Job | Local equivalent must run through Docker Compose |
| Raw and derived artifacts | Private Azure Blob Storage | No public blob access or permanent public capability URLs |
| Queue | Azure Storage Queue | Reuse existing queue module and managed-identity pattern |
| Job state | Azure Table Storage for MVP | Consider PostgreSQL only when durable relational queries are required |
| Native PDF parsing | `pypdfium2`, `pdfminer.six` or `pdfplumber`, and `qpdf` | Review dependency licenses before production |
| Managed extraction | Azure Document Intelligence v4 `prebuilt-layout` | Do not use `prebuilt-bankStatement` as the UAE primary model; it is US-English oriented |
| Private OCR fallback | RapidOCR + ONNX Runtime CPU | Use English/Latin and Arabic PP-OCR models and RTL handling |
| Dataframes | Polars | Prefer lazy operations and Parquet artifacts |
| Exact arithmetic | Python `decimal.Decimal` | Currency-aware precision and rounding rules |
| Fuzzy text | RapidFuzz | Candidate generation only |
| Multilingual text embeddings | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, ONNX-quantized | Optional candidate generation; not the source of truth |
| Graph analysis | NetworkX directed multigraph | Bound cycles to keep runtime predictable; evaluate Rustworkx when needed |
| Baseline classifiers | scikit-learn logistic regression | Calibrated, explainable, lightweight |
| Challenger classifiers | LightGBM or CatBoost | Use only with labeled validation data |
| Model registry | MLflow/Azure Machine Learning | Store model lineage, signatures, validation, aliases, and approvals |
| Observability | OpenTelemetry + Application Insights | Redact PII and financial content before emission |
| Local Azure emulation | Azurite | No live Azure dependency for core local tests |
| Test stack | pytest, Hypothesis, golden fixtures | Property-test accounting invariants |

## 8. Extraction strategy

### 8.1 Fast path for digital PDFs

If a PDF contains a reliable text layer:

1. Extract words, characters, and coordinates locally.
2. Render pages for visual comparison and evidence.
3. Compare extracted ordering with the rendered layout.
4. Use OCR only for pages or regions where embedded text is absent, corrupt, or materially inconsistent.

Native text should not automatically be trusted. Some altered PDFs contain a visible image plus a different embedded text layer. The integrity engine must compare both representations where possible.

### 8.2 Managed layout path

Use Azure Document Intelligence v4 `prebuilt-layout` for scanned statements and difficult tables. Preserve the complete provider response privately for debugging only when retention policy allows it; expose only provider-neutral canonical results publicly.

Call the Delete Analyze Result API as soon as the extraction result has been retrieved, where supported. Verify that the selected service and approved region satisfy UAE data-residency requirements before any cloud use.

### 8.3 Private OCR path

When cloud document processing is not approved or available in the required UAE region, use:

- RapidOCR;
- ONNX Runtime CPU;
- PP-OCR mobile or small text detection;
- English/Latin recognition model;
- Arabic recognition model;
- orientation classification; and
- right-to-left text reordering.

The OCR container must pin model checksums in the image and must not download models during runtime.

### 8.4 Extraction interface

Every extractor must implement the same internal interface:

```python
class Extractor(Protocol):
    def analyze(self, document: DocumentInput) -> ExtractedDocument:
        ...
```

`ExtractedDocument` must include pages, words, lines, tables, cells, coordinates, confidences, extraction method, provider-neutral warnings, and model/version metadata.

## 9. Multi-statement and multi-account processing

One upload may contain:

- statements from multiple banks;
- several accounts from one bank;
- a current account plus credit card or loan statement;
- multiple statement periods;
- repeated or overlapping periods;
- different owners or joint owners;
- different currencies; and
- separator pages or unrelated documents.

### 9.1 Page segmentation signals

Use:

- bank name and logo text;
- page header and footer tokens;
- page number and total-page count;
- visible or masked account number;
- IBAN fragments;
- statement period;
- currency;
- balance labels;
- product-type labels;
- holder names;
- layout fingerprint; and
- similarity to neighboring pages.

Start with deterministic segmentation. After labeled pages exist, add a LightGBM or CatBoost page classifier. A classifier result may propose a segment but must not override conflicting account identifiers or page numbering without a warning.

### 9.2 Segment output

Each detected statement segment contains:

```json
{
  "statementSegmentId": "seg_...",
  "pageRange": {"from": 1, "to": 6},
  "bankNameRaw": "Example Bank PJSC",
  "bankId": "example-bank",
  "accountFingerprint": "sha256:...",
  "productType": "current_account",
  "period": {"from": "2026-01-01", "to": "2026-03-31"},
  "currencies": ["AED"],
  "confidence": 0.98,
  "warnings": []
}
```

### 9.3 Duplicate and overlap prevention

Create stable fingerprints from:

- tenant-scoped account fingerprint;
- booking date;
- value date;
- normalized signed amount;
- currency;
- normalized description;
- transaction reference; and
- running balance.

Never deduplicate solely by amount and date. Store duplicate groups and the chosen retained record so the decision is auditable.

Overlapping periods must produce a coverage matrix and must not double-count transactions.

## 10. Canonical data model

The canonical schema is the boundary between extraction and analytics. Analytics must not parse raw bank tables directly.

### 10.1 Money

```json
{
  "value": "12540.750",
  "currency": "KWD",
  "scale": 3
}
```

Rules:

- `value` is always a decimal string.
- `currency` uses an ISO 4217 code where one exists.
- Preserve the source precision.
- Define currency-specific arithmetic precision explicitly.
- Unknown currency produces an unsupported-ledger warning.

### 10.2 Evidence reference

```json
{
  "documentId": "doc_...",
  "statementSegmentId": "seg_...",
  "page": 3,
  "boundingPolygon": [[10.1, 20.4], [80.0, 20.4], [80.0, 31.2], [10.1, 31.2]],
  "rawText": "2,500.00 DR",
  "extractionMethod": "azure-layout-v4",
  "extractionConfidence": 0.994
}
```

### 10.3 Owner

```json
{
  "ownerId": "owner_...",
  "nameRaw": "CUSTOMER NAME",
  "nameNormalized": "customer name",
  "role": "joint_owner",
  "attributionConfidence": 0.97,
  "evidence": []
}
```

Valid roles include `owner`, `joint_owner`, `primary_owner`, `authorized_signatory`, `supplementary_cardholder`, and `unknown`.

### 10.4 Account

```json
{
  "accountId": "acc_...",
  "bankId": "example-bank",
  "accountNumberMasked": "******1234",
  "ibanMasked": "AE****************1234",
  "accountFingerprint": "sha256:tenant-scoped-value",
  "productType": "current_account",
  "ledgerNature": "asset",
  "ownershipType": "joint",
  "owners": [],
  "ledgerCurrencies": ["AED"]
}
```

Account identifiers in logs and public responses must remain masked or tenant-scoped hashes.

### 10.5 Balance

```json
{
  "balanceId": "bal_...",
  "type": "closing_booked",
  "amount": {"value": "2500.00", "currency": "AED", "scale": 2},
  "creditDebitIndicator": "DEBIT",
  "canonicalSignedValue": "-2500.00",
  "asOf": "2026-09-30",
  "sourceLabel": "Closing Balance DR",
  "evidence": []
}
```

Balance types include:

- `opening_booked`;
- `closing_booked`;
- `current`;
- `available`;
- `interim`;
- `forward_available`;
- `overdraft_limit`;
- `credit_limit`; and
- `unknown`.

Do not equate available balance with closing booked balance.

### 10.6 Transaction

```json
{
  "transactionId": "txn_...",
  "accountId": "acc_...",
  "ledgerCurrency": "AED",
  "bookingDate": "2026-09-12",
  "valueDate": "2026-09-11",
  "descriptionRaw": "POS PURCHASE USD 100.00",
  "descriptionNormalized": "pos purchase usd 100.00",
  "referenceRaw": "REF123",
  "creditDebitIndicator": "DEBIT",
  "ledgerAmount": {"value": "371.25", "currency": "AED", "scale": 2},
  "originalAmount": {"value": "100.00", "currency": "USD", "scale": 2},
  "exchangeRate": "3.7125",
  "runningBalance": {
    "amount": {"value": "8128.75", "currency": "AED", "scale": 2},
    "creditDebitIndicator": "CREDIT",
    "canonicalSignedValue": "8128.75"
  },
  "bankTransactionCodeRaw": "PUR",
  "counterpartyId": "cp_...",
  "economicClassification": {
    "direction": "outflow",
    "category": "card_purchase",
    "confidence": 0.96,
    "method": "rules-v1"
  },
  "evidence": []
}
```

Only `ledgerAmount` affects the statement ledger. `originalAmount` and exchange-rate fields are supporting facts.

### 10.7 Facility

```json
{
  "facilityType": "overdraft",
  "accountId": "acc_...",
  "limit": {"value": "10000.00", "currency": "AED", "scale": 2},
  "utilized": {"value": "2500.00", "currency": "AED", "scale": 2},
  "available": {"value": "7500.00", "currency": "AED", "scale": 2},
  "calculationMethod": "reported",
  "evidence": []
}
```

An overdraft or credit limit is not income and is not an account balance.

## 11. Sign and accounting conventions

Use an ISO 20022-inspired convention:

- a `CREDIT` balance has a positive canonical value;
- a `DEBIT` balance has a negative canonical value;
- a `CREDIT` entry increases canonical balance; and
- a `DEBIT` entry decreases canonical balance.

Preserve the bank’s original labels and columns even after normalization.

The system must keep these concepts separate:

- debit or credit transaction;
- debit or credit balance;
- credit product;
- credit limit;
- available credit;
- overdraft facility;
- accounting effect; and
- economic purpose.

For credit cards and loans, the canonical balance may represent a liability. The account’s `ledgerNature` and product type determine economic interpretation. A card purchase is not an income outflow from a deposit ledger, and a card payment is not income to the cardholder.

## 12. Reconciliation engine

Reconcile each `(accountId, statementSegmentId, ledgerCurrency, ledgerType)` independently.

### 12.1 Statement-level invariant

```text
canonical closing balance
= canonical opening balance
+ sum(canonical signed transaction effects)
+ explicit documented adjustments
```

### 12.2 Row-level invariant

```text
previous canonical running balance
+ signed transaction effect
= current canonical running balance
```

### 12.3 Valid statuses

- `fully_reconciled`;
- `reconciled_with_explicit_rounding`;
- `partially_reconciled`;
- `unreconciled`; and
- `insufficient_information`.

### 12.4 Tolerance

Use the smallest representable unit for the currency unless the statement explicitly documents another rounding behavior. Any rounding adjustment must be stored as its own derived adjustment with evidence and formula version. Do not use a wide tolerance to force reconciliation.

### 12.5 Ambiguous debit/credit columns

When a bank layout is ambiguous, generate candidate mappings and test them against the printed balances. Select a mapping only if one candidate reconciles and the interpretation is consistent across the segment. Otherwise return an ambiguity warning and require review.

## 13. Terminology and bank-format registry

Bank-specific mapping is configuration, not analytics code.

```yaml
bank: example-bank
format_version: 2026-01
effective_from: 2026-01-01
locales: [en-AE, ar-AE]
product_types: [current_account, savings_account]
columns:
  transaction_date:
    aliases: [Date, Txn Date, "تاريخ المعاملة"]
  debit:
    aliases: [Debit, Withdrawal, DR]
  credit:
    aliases: [Credit, Deposit, CR]
  running_balance:
    aliases: [Balance, Running Balance]
number_format:
  decimal_separator: "."
  thousands_separator: ","
balance_convention: credit_positive
```

Every mapping records:

- bank and locale;
- product type;
- source term or column pattern;
- canonical concept;
- number and date formats;
- sign convention;
- statement version or effective dates;
- mapping version; and
- validation fixtures.

No bank profile may define lender risk thresholds, affordability formulas, or credit policy.

## 14. Ownership and related-account resolution

Return one of:

- `confirmed_self_owned`;
- `probable_self_owned`;
- `possible_self_owned`;
- `third_party`; or
- `unknown`.

Evidence may include:

- exact or partially visible account identifier;
- holder-name overlap;
- customer declaration;
- one transaction appearing on both uploaded ledgers with matching currency, amount, date, and reference;
- repeated sweeping behavior;
- reciprocal transfer patterns; and
- later, approved Open Finance ownership evidence.

Name similarity alone cannot confirm ownership.

Self-transfers are removed from consolidated income and expenditure but remain in the canonical transactions and graph.

Joint ownership is represented independently of transaction ownership. Do not divide account income between owners without explicit attribution evidence.

## 15. Counterparty and employer resolution

### 15.1 Normalization

Normalize counterparties using:

- Unicode normalization;
- Arabic diacritic removal;
- Arabic and English punctuation normalization;
- whitespace and digit normalization;
- legal-suffix dictionaries;
- bank-reference token removal;
- character n-grams;
- RapidFuzz similarity; and
- optional multilingual MiniLM embeddings for candidate generation.

### 15.2 Matching

Final matching considers:

- account and IBAN evidence;
- transaction direction;
- recurrence;
- amount behavior;
- reference-number agreement;
- employer/payroll terms;
- name and transliteration similarity; and
- customer-declared relationships.

Embeddings must not be the only evidence for an identity match.

### 15.3 Employer outputs

Return `observedEmployer`, not `verifiedEmployer`, unless an approved independent source corroborates it.

Track:

- raw and normalized payer name;
- first and last observed payment;
- payment count;
- cadence;
- median and variability;
- WPS or payroll indicator;
- salary gaps or partial payments;
- possible employer change;
- owner attribution for joint accounts;
- circularity or self-funding concern; and
- confidence and evidence.

## 16. Income analysis

Separate:

- gross credits;
- confirmed external credits;
- stable eligible income;
- variable income;
- probable salary;
- business revenue;
- self-transfers;
- circular credits;
- loan proceeds;
- refunds and reversals;
- cash deposits;
- investment income;
- one-off windfalls; and
- unknown credits.

Core formula:

```text
eligible external income
= gross credits
- confirmed self-transfer credits
- circular credits
- loan proceeds
- refunds and reversals
- identified one-off windfalls
```

The formula is applied by account, owner attribution, month, and currency before any consolidated reporting.

### 16.1 Salary candidate features

- external payer;
- repeated normalized payer;
- payroll or WPS tokens;
- monthly or fortnightly periodicity;
- stable payment day;
- amount coefficient of variation;
- observation count;
- gaps and partial payments;
- immediate outward transfer;
- circular return;
- self-owned payer; and
- description similarity.

Start with deterministic rules and reason codes. Train a supervised LightGBM salary classifier only after representative labels exist.

### 16.2 Self-employed and business revenue

Analyze separately:

- merchant settlements;
- customer concentration;
- revenue seasonality;
- cash-deposit dependency;
- refunds and chargebacks;
- related-party revenue;
- recurring supplier payments;
- operating-expense coverage; and
- month-over-month trend.

## 17. Circular transaction engine

Circularity is graph analysis, not a generative-AI task.

### 17.1 Graph model

Build a directed temporal multigraph:

- nodes are accounts and normalized counterparties;
- edges are transactions;
- edge attributes include amount, currency, booking/value dates, reference, ownership relationship, source transaction, and confidence.

Partition by currency before cycle analysis. Cross-currency edges may only be linked where explicit FX evidence exists.

### 17.2 Patterns

Detect:

1. direct round trips: `A -> B -> A`;
2. bounded multi-hop cycles: `A -> B -> C -> A`;
3. cross-bank self-funding;
4. salary-like funds transferred out and substantially returned;
5. balance boosting before statement generation or application;
6. one amount split into several outward payments and recombined inward;
7. repeated high gross turnover with low net external funding; and
8. loan-funded inflows later presented as income or turnover.

For the MVP, bound cycles to two through four nodes and a configurable time window. Do not enumerate arbitrary unbounded cycles.

### 17.3 Amount matching

Match using:

- exact currency;
- exact or currency-scale tolerance;
- known fees;
- amount conservation ratio;
- date window;
- reference similarity;
- ownership evidence; and
- split/recombine groups.

### 17.4 False-positive controls

Do not automatically treat the following as harmful circularity:

- transfers to savings;
- credit-card repayments;
- brokerage funding;
- fixed-deposit placement and maturity;
- refunds and reversals;
- treasury sweeping;
- joint-account transfers;
- documented FX conversion; and
- loan disbursement followed by its declared use.

### 17.5 Outputs

```json
{
  "cycleId": "cycle_...",
  "cycleType": "direct_round_trip",
  "transactionIds": ["txn_1", "txn_2"],
  "nodeIds": ["acc_1", "acc_2"],
  "grossAmount": {"value": "20000.00", "currency": "AED", "scale": 2},
  "netNewMoney": {"value": "0.00", "currency": "AED", "scale": 2},
  "returnLagDays": 2,
  "amountConservationRatio": "0.9975",
  "incomeTreatment": "excluded",
  "confidence": 0.96,
  "reasonCodes": ["FUNDS_RETURNED_TO_ORIGIN"],
  "evidence": []
}
```

Aggregate features include:

- self-transfer ratio;
- circular-credit ratio;
- external-funding ratio;
- net-new-money ratio;
- cycle count;
- median return lag; and
- circular funds by month, account, currency, and counterparty.

## 18. Balance, liquidity, overdraft, and credit analysis

Per account and currency, calculate:

- opening and closing booked balance;
- time-weighted average daily balance;
- minimum and maximum daily balance;
- days with a debit/negative balance;
- days below configurable liquidity buffer;
- end-of-month balances;
- salary-to-minimum-balance depletion time;
- overdraft limit, utilization, and breach count;
- overdraft interest and fee events;
- credit limit and available credit;
- dormant and active periods; and
- balance volatility and trend.

Do not treat an overdraft limit, credit limit, card balance, or loan disbursement as income.

## 19. Expenses and observed obligations

Classify and measure:

- loan and finance repayments;
- credit-card payments;
- rent;
- utilities;
- insurance;
- telecom;
- education;
- government payments;
- standing orders and direct debits;
- remittances;
- cheques;
- observed court or maintenance payments where explicitly evidenced;
- cash withdrawals;
- business expenses; and
- discretionary expenditure.

Each observed obligation contains frequency, typical amount, variability, last-observed date, probable creditor, missed or returned instances, confidence, and evidence.

An observed payment does not establish remaining principal, interest rate, tenor, or legal liability. Those fields require customer documents, lender records, or credit-bureau data.

## 20. Affordability feature layer

The BSA API returns lender-neutral inputs:

- stable monthly income;
- variable monthly income;
- monthly observed obligations;
- disposable cash flow;
- average and worst-month surplus;
- months with negative net cash flow;
- expense-to-income ratio;
- observed debt-service-to-income ratio;
- income and cash-flow volatility;
- liquidity buffer;
- stress-test results;
- missing DBR inputs; and
- evidence and formula versions.

Stress scenarios may include:

- removal of variable income;
- reduction of the largest income source;
- increased finance cost;
- increased essential expenditure;
- employer or payer loss; and
- adverse FX movement where income and obligations use different currencies.

The lender applies its approved DBR, affordability, product, and exception policies outside the BSA service.

## 21. Irregularity and integrity analysis

Keep three classes separate.

### 21.1 Document integrity signals

- unreconciled balances;
- missing, duplicated, or reordered pages;
- conflicting account identifiers;
- inconsistent fonts or text layers;
- image overlays;
- OCR-visible text disagreement;
- metadata inconsistent with statement dates;
- altered totals without supporting entries;
- same-period statements with different closing balances;
- duplicate transactions with changed amounts; and
- bank-template mismatch.

These are review signals, not proof of fraud.

### 21.2 Financial irregularities

- sudden unexplained turnover increase;
- unusually large round-number credits;
- high-value credits just before an application or statement close;
- temporary activation of a dormant account;
- cash-deposit concentration;
- frequent reversals or returned payments;
- overdraft-limit breaches;
- salary interruptions;
- rapidly declining monthly surplus;
- rapid balance depletion after income receipt;
- new high-value recurring obligations; and
- counterparty concentration inconsistent with declared activity.

### 21.3 Cross-document inconsistencies

- holder-name disagreement for the same account;
- conflicting balances for the same date;
- conflicting currency or product classifications;
- unexplained employer-name changes;
- duplicate periods with missing or changed transactions; and
- one statement copy omitting rows found in another.

### 21.4 Statistical detection

Use robust statistics before unsupervised ML:

- median absolute deviation;
- rolling median and percentile bands;
- seasonality-aware comparisons;
- change-point detection; and
- concentration and frequency shifts.

`IsolationForest` may be used only as a challenger alert generator. Its output must not directly produce a credit decline.

## 22. Multi-currency behavior

Reconcile each currency independently.

For FX transactions preserve:

- original amount and currency;
- account or settlement amount and currency;
- exchange rate;
- fee;
- rate source if known;
- rate date; and
- source evidence.

Consolidated analytics require an explicit reporting currency and approved FX source. Responses must disclose original values, converted values, rates, dates, formula, and currency coverage.

Do not convert currencies for cycle matching unless explicit linked FX transactions or rate evidence exists.

## 23. Decision-support output sections

The completed response should contain:

1. `analysis` — identifiers, lifecycle, versions, and timestamps.
2. `coverage` — banks, accounts, periods, currencies, missing and overlapping ranges.
3. `documents` — files, segments, pages, duplicates, and integrity signals.
4. `subjects` — applicant/entity and declared information.
5. `accounts` — product, ownership, holders, currencies, and facilities.
6. `balances` — normalized reported and derived balances.
7. `transactions` or a protected artifact reference for large result sets.
8. `counterparties` — normalized identities and confidence.
9. `income` — gross, external, stable, variable, excluded, and unknown.
10. `employers` — observed employers and salary streams.
11. `obligations` — recurring observed commitments.
12. `cashFlow` — monthly inflow, outflow, surplus, volatility, and trend.
13. `liquidity` — daily balances, overdraft, buffer, and depletion.
14. `circularity` — cycles, self-transfers, and net-new-money measures.
15. `irregularities` — document, financial, and cross-document signals.
16. `affordabilityFeatures` — lender-neutral inputs and stress results.
17. `quality` — extraction, reconciliation, ownership, classification, and coverage quality.
18. `findings` — evidence-backed reason codes.
19. `artifacts` — authenticated, tenant-scoped report or data exports.
20. `limitations` — missing data and unsupported conclusions.

Avoid a single opaque `credibilityScore`. Return separate dimensions such as:

- `documentReliability`;
- `ledgerReconciliationQuality`;
- `incomeReliability`;
- `employerContinuity`;
- `cashFlowStability`;
- `liquidityAdequacy`;
- `obligationConsistency`;
- `circularityRisk`;
- `statementCoverageQuality`; and
- `ownershipConfidence`.

## 24. Public API contract

### 24.1 Submit analysis

```http
POST /service/bank_statement_analysis
Authorization: Bearer <customer-api-key>
Idempotency-Key: <customer-generated-key>
Content-Type: multipart/form-data
```

Fields:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `statement_file` | PDF/JPEG/PNG/TIFF | yes | No remote URL in MVP |
| `country_code` | string | yes | Initially `AE` |
| `entity_type` | enum | yes | `individual`, `sole_proprietor`, or `company` |
| `declared_names` | JSON array | no | Used as declared evidence, not truth |
| `declared_employer` | string | no | Compared with observed payers |
| `declared_monthly_income` | decimal string | no | Never represented as JSON float |
| `declared_income_currency` | ISO currency | conditional | Required with declared income |
| `reporting_currency` | ISO currency | no | Consolidation remains optional |
| `customer_reference` | string | no | Must be length-limited and log-safe |
| `callback_url` | HTTPS URL | no | Existing callback validation/signing conventions apply |
| `get_pdf` | boolean | no | Default false |

Initial safety limits should be configuration, not hard-coded contract promises. Recommended local MVP defaults:

- maximum upload: 25 MiB;
- maximum pages: 100;
- accepted content determined by magic bytes, not filename;
- password-protected PDF: reject with safe reason code;
- maximum transactions: 20,000 before requiring a bounded export path; and
- one active analysis per idempotency key.

### 24.2 Accepted response

```json
{
  "analysisId": "bsa_...",
  "status": "queued",
  "receivedAt": "2026-10-26T12:00:00Z",
  "statusUrl": "https://api.ai7uae.com/service/bank_statement_analysis/bsa_...",
  "resultUrl": "https://api.ai7uae.com/service/bank_statement_analysis/bsa_.../result"
}
```

Return HTTP `202` after durable storage and queue submission. Do not keep the request open for extraction.

### 24.3 Status

```http
GET /service/bank_statement_analysis/{analysisId}
Authorization: Bearer <customer-api-key>
```

Lifecycle states:

- `received`;
- `queued`;
- `validating`;
- `extracting`;
- `segmenting`;
- `normalizing`;
- `reconciling`;
- `analyzing`;
- `completed`;
- `partial`;
- `failed`; and
- `expired`.

### 24.4 Result

```http
GET /service/bank_statement_analysis/{analysisId}/result
Authorization: Bearer <customer-api-key>
```

Results and reports must require authorization and tenant ownership. Do not reuse the permanent unauthenticated capability-link pattern used by lower-sensitivity reports.

### 24.5 Delete

```http
DELETE /service/bank_statement_analysis/{analysisId}
Authorization: Bearer <customer-api-key>
```

Deletion is a separate future API decision and must be designed with retention and audit requirements. The implementation agent must not expose this endpoint until policy and recoverability are approved.

## 25. Error and partial-result semantics

Public errors are provider-neutral and must not expose internal hostnames, credentials, model paths, Blob names, or stack traces.

Suggested reason codes include:

- `UNSUPPORTED_FILE_TYPE`;
- `FILE_TOO_LARGE`;
- `PAGE_LIMIT_EXCEEDED`;
- `PASSWORD_PROTECTED_PDF`;
- `MALWARE_CHECK_FAILED`;
- `NO_STATEMENT_DETECTED`;
- `UNSUPPORTED_BANK_FORMAT`;
- `MISSING_STATEMENT_PAGE`;
- `OVERLAPPING_PERIODS_DEDUPLICATED`;
- `LEDGER_NOT_RECONCILED`;
- `AMBIGUOUS_DEBIT_CREDIT_MAPPING`;
- `UNKNOWN_CURRENCY`;
- `OWNER_ATTRIBUTION_AMBIGUOUS`;
- `EXTRACTION_PROVIDER_UNAVAILABLE`;
- `RESULT_REQUIRES_MANUAL_REVIEW`; and
- `RETENTION_EXPIRED`.

`completed` means all required processing succeeded within the documented coverage. `partial` means useful evidence exists but at least one required component is missing or inconclusive. A partial result is not decision-eligible by default.

## 26. Model plan

### 26.1 MVP model inventory

| Model/component | MVP choice | Role | May drive decline? |
|---|---|---|---:|
| Layout extraction | Azure Document Intelligence v4 Layout | OCR and tables | no |
| Private OCR | RapidOCR/PP-OCR ONNX | OCR fallback | no |
| Page segmentation | deterministic rules | statement splitting | no |
| Transaction category | rules + TF-IDF/logistic regression | evidence classification | no |
| Counterparty candidates | RapidFuzz + optional multilingual MiniLM | candidate generation | no |
| Self-owned account | deterministic evidence score | relationship inference | no |
| Salary candidate | deterministic feature score | income classification | no |
| Circularity | bounded temporal graph algorithm | recycled-funds evidence | no |
| Irregularity | rules + robust statistics | review signals | no |
| Credit decision | none in MVP | lender-owned decision | not applicable |

### 26.2 Later supervised models

After labeled data exists:

- LightGBM page segment classifier;
- LightGBM entity-match model;
- LightGBM salary classifier;
- hierarchical transaction classifier;
- regularized logistic credit scorecard; and
- monotonic LightGBM challenger.

No production model may be introduced without an approved objective, feature definition, representative training set, leakage review, independent validation, monitoring plan, rollback plan, and documented limitations.

## 27. Training-data requirements

### 27.1 Data classes

Build separate labeled datasets for:

1. page-to-statement segmentation;
2. table and field extraction;
3. transaction categorization;
4. counterparty entity resolution;
5. salary and employer identification;
6. self-owned account relationships;
7. circular transaction examples;
8. document-integrity signals; and
9. future credit outcomes.

Do not combine these labels into one opaque training target.

### 27.2 Data governance

- Prefer synthetic statements and contractually approved, redacted samples during MVP development.
- Do not commit real statements.
- Store approved training data only in a dedicated private container.
- Record lawful purpose, consent or other legal basis, provenance, permitted uses, retention, and deletion status.
- Tokenize or mask account identifiers before labeling where possible.
- Keep annotator access least-privileged and auditable.
- Exclude protected and sensitive characteristics from credit-feature datasets.

### 27.3 Annotation requirements

Each sample should record:

- bank and format version;
- language;
- scan versus digital origin;
- account and product type;
- currency;
- expected pages and segments;
- expected fields and transaction rows;
- expected debit/credit interpretation;
- expected reconciliation;
- owner and counterparty labels with confidence;
- category and exclusion reason; and
- reviewer and review date.

Financial labels require two-person review for the gold test set.

### 27.4 Dataset splitting

Split by customer/entity, bank format, and time. Do not let pages from the same statement or near-duplicate account histories appear in both training and validation sets.

Maintain an out-of-bank test set containing layouts not seen in training.

### 27.5 Indicative starting targets

These are planning targets, not production sufficiency claims:

- at least 20–50 representative statements for each high-priority bank/layout before relying on a custom extraction model;
- thousands of labeled transaction descriptions across banks for a useful categorizer;
- several thousand positive and negative entity-pair examples for entity matching;
- salary and non-salary recurring credits across employment patterns; and
- synthetic plus reviewed real examples for each circularity pattern and false-positive category.

The MVP must remain useful through deterministic rules while training data is accumulated.

## 28. Evaluation metrics

### 28.1 Extraction

- word and character error rate;
- exact-match accuracy for account, dates, currencies, and balances;
- transaction-row precision, recall, and F1;
- exact amount and date accuracy;
- table-column mapping accuracy; and
- page segmentation precision, recall, and boundary accuracy.

### 28.2 Financial correctness

- percentage of ledgers fully reconciled;
- unexplained reconciliation difference by currency;
- running-balance agreement rate;
- duplicate and overlap detection accuracy;
- daily-balance exactness; and
- multi-currency separation accuracy.

Any numeric parsing error in a gold statement is a high-severity defect even when aggregate F1 remains high.

### 28.3 Classification

- per-class precision, recall, and F1;
- probability calibration;
- high-confidence error rate;
- false income inclusion rate;
- false self-account match rate;
- salary precision at the chosen confidence threshold;
- circularity precision and false-positive rate; and
- performance by bank, language, product, currency, and scan quality.

### 28.4 Future credit model

If a credit model is later introduced, evaluate at least discrimination, calibration, stability, segment performance, back-testing, overrides, drift, and prohibited-proxy risk. Statistical performance alone is not sufficient.

## 29. Explainability and reason codes

Every material feature follows this shape:

```json
{
  "feature": "stable_monthly_salary",
  "value": {"amount": "18000.00", "currency": "AED", "scale": 2},
  "method": "median_of_6_eligible_payroll_credits",
  "formulaVersion": "income-v1.0.0",
  "includedTransactionIds": ["txn_1", "txn_8", "txn_14"],
  "excludedTransactionIds": ["txn_4"],
  "exclusionReasons": {"txn_4": "SALARY_ADVANCE"},
  "confidence": 0.94,
  "evidence": []
}
```

Approved decision-support reason codes may include:

- `INSUFFICIENT_STABLE_INCOME_HISTORY`;
- `HIGH_OBSERVED_DEBT_SERVICE`;
- `FREQUENT_NEGATIVE_BALANCE`;
- `STATEMENT_COVERAGE_INCOMPLETE`;
- `CIRCULAR_FUNDS_REDUCED_ELIGIBLE_INCOME`;
- `INCOME_PAYER_CHANGED`;
- `VARIABLE_INCOME_EXCLUDED_FROM_STABLE_INCOME`;
- `JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED`; and
- `LEDGER_RECONCILIATION_FAILED`.

Reason codes must be stable and documented. Raw SHAP values are not customer explanations.

## 30. Security, privacy, and tenant isolation

Bank statements contain highly sensitive personal and financial data.

Required controls:

- derive tenant ownership from authenticated server-side key records;
- never accept caller-provided tenant authority;
- use managed identity and workload identity federation;
- keep raw and derived Blob containers private and non-listable;
- disable shared-key access where the existing architecture supports it;
- use least-privilege data-plane roles;
- use short-lived upload and processing artifacts;
- require Bearer authorization for result and report downloads;
- do not use permanent unauthenticated capability URLs;
- redact names, account numbers, IBANs, descriptions, balances, and signed URLs from logs;
- encrypt data at rest and in transit;
- validate file magic bytes and decompression limits;
- perform malware scanning before extraction;
- prevent cross-tenant job, status, and artifact access;
- never send raw statements to a general-purpose LLM;
- never store secret values in source, GitHub variables, model artifacts, or logs; and
- record model, rule, formula, and schema versions without recording raw PII.

### 30.1 Retention

Retention must be policy-driven and tenant-configurable only within approved bounds.

Proposed MVP defaults for review:

- raw upload: delete after successful analysis or within 24 hours;
- temporary page images: delete immediately after artifact generation;
- managed-extractor results: delete immediately after retrieval where supported;
- normalized transaction artifact: shortest approved customer contract period;
- aggregate result: approved product retention;
- audit evidence: hashes, versions, reason codes, and access events without unnecessary raw content.

Do not implement lifecycle deletion until retention, legal hold, recovery, and audit requirements are approved.

## 31. Cost and performance controls

The BSA ceiling must be approved separately from the merchant-screening `$0.05` ceiling. Do not assume that ceiling applies to multi-page bank statements.

Cost controls:

- use native PDF text extraction before paid OCR;
- send only required pages or regions to managed extraction;
- reject unsupported or over-limit files before provider calls;
- cache extraction by tenant-scoped document hash where policy permits;
- pin page and transaction limits;
- use CPU inference and scale to zero;
- do not invoke LLMs in the normal path;
- meter pages and model calls internally;
- return safe partial results when cost limits are reached; and
- benchmark cost by digital versus scanned page and by bank format.

Initial worker profiles:

```text
Managed-layout path: 1 vCPU / 2 GiB, min 0, max 3
Private-OCR path:     2 vCPU / 4 GiB, min 0, max 2
GPU:                  none
```

Targets must be measured locally and in an approved non-production environment before they become service-level commitments.

## 32. Observability

Allowed telemetry:

- analysis state and duration;
- page and transaction counts;
- bank-format identifier;
- extractor and model versions;
- reconciliation status;
- reason-code counts;
- provider latency and status class;
- redacted cost units;
- worker resource use; and
- retry counts.

Prohibited telemetry:

- holder names;
- account numbers and IBANs;
- transaction descriptions;
- transaction references;
- amounts or balances;
- raw model prompts or responses containing statement data;
- document URLs or signed Blob URLs; and
- raw provider payloads.

Use correlation IDs that are not derived from account identifiers.

## 33. Local development

The local MVP must not require access to production or shared Azure resources.

Recommended local composition:

```text
api              existing Node API
bsa-worker       Python analysis worker
azurite          local Blob, Queue, and Table emulation
extractor-stub   deterministic fixtures for managed-layout responses
```

Suggested repository layout:

```text
bank-statement-analysis/
  pyproject.toml
  Dockerfile
  src/bsa/
    contracts/
    extraction/
    segmentation/
    bank_profiles/
    normalization/
    reconciliation/
    entities/
    circularity/
    analytics/
    findings/
    storage/
    worker/
  tests/
    fixtures/
    gold/
    property/
    integration/
```

The exact location may be adjusted to repository conventions, but public API code, private worker code, and reusable canonical contracts must remain clearly separated.

### 33.1 Test data

Use synthetic fixtures representing:

- digital English statement;
- scanned English statement;
- Arabic statement;
- mixed Arabic/English statement;
- one PDF containing multiple banks;
- one account with overlapping periods;
- joint account;
- multiple currencies;
- overdraft account;
- credit-card statement;
- salary and employer change;
- self-owned account transfer;
- direct circular transaction;
- multi-hop cycle;
- split-and-recombine cycle;
- legitimate savings sweep;
- refund and reversal;
- missing page;
- duplicate page;
- altered running balance; and
- ambiguous debit/credit columns.

Fixtures must not contain real customer PII.

## 34. Testing strategy

### 34.1 Unit tests

- currency parsing and decimal precision;
- date and number formats;
- sign conventions;
- canonical schema validation;
- debit/credit mapping;
- reconciliation formulas;
- duplicate fingerprints;
- period coverage;
- daily-balance calculation;
- income exclusion formulas;
- joint-owner attribution;
- self-transfer matching;
- cycle amount conservation; and
- reason-code generation.

### 34.2 Property-based tests

Use Hypothesis to assert:

- adding a credit and its exact debit reversal returns the prior canonical balance;
- statement totals remain invariant under transaction input ordering after sorting by the documented ledger order;
- currency ledgers never combine;
- serialization and deserialization preserve decimal values exactly;
- duplicate removal never removes transactions with different references or running balances without explicit duplicate evidence;
- self-transfers change per-account balances but not consolidated net-new money; and
- cycle exclusions never increase eligible external income.

### 34.3 Golden tests

Every bank profile requires one or more gold fixtures containing expected segments, balances, transactions, reconciliation, classifications, and evidence coordinates.

### 34.4 Integration tests

- multipart upload to durable queue;
- idempotency behavior;
- tenant isolation;
- worker retry without duplicate processing;
- extractor failure producing a partial result;
- local Azurite artifact lifecycle;
- authenticated result retrieval;
- callback signature and retry behavior if enabled; and
- no PII in captured logs.

### 34.5 Security tests

- MIME and magic-byte mismatch;
- zip/PDF decompression bomb controls;
- malformed PDF;
- oversized image dimensions;
- password-protected PDF;
- cross-tenant analysis ID guessing;
- forged callback target;
- path traversal in filenames;
- parser timeout;
- provider payload injection; and
- log redaction.

## 35. MVP delivery milestones

Each milestone must be locally testable and independently reviewable.

### M0 — contracts and worker foundation

- Create versioned Pydantic canonical contracts.
- Create Python worker package and container.
- Add Azurite-backed job and artifact interfaces.
- Add synthetic fixture policy and redaction tests.
- Document commands for local execution.

Exit criteria: contracts round-trip without decimal loss; worker consumes and completes a synthetic job locally.

### M1 — extraction and page segmentation

- Implement file validation and hashing.
- Implement PDF rendering and native-text extraction.
- Define provider-neutral extractor interface.
- Implement deterministic page segmentation.
- Add managed-layout stub and private OCR adapter interface.

Exit criteria: a combined synthetic PDF is split into correct statement segments with page evidence.

### M2 — canonical ledger and reconciliation

- Implement money, balance, transaction, and evidence models.
- Implement bank-profile registry.
- Implement candidate column mappings.
- Implement row and statement reconciliation.
- Implement explicit partial and ambiguous states.

Exit criteria: all gold ledgers reconcile exactly; incorrect mappings fail closed.

### M3 — multi-account consolidation

- Implement account fingerprints.
- Implement overlapping-period coverage.
- Implement duplicate transaction groups.
- Implement daily balances and per-currency aggregation.
- Support deposit, overdraft, credit-card, and loan products.

Exit criteria: overlapping statements do not double-count and currencies remain isolated.

### M4 — ownership and entity resolution

- Normalize owner and counterparty names.
- Implement self-owned-account evidence scoring.
- Implement joint-owner attribution states.
- Add optional multilingual embedding candidate adapter.

Exit criteria: confirmed, probable, possible, third-party, and unknown relationships are supported with evidence.

### M5 — income, salary, employer, and obligations

- Implement income decomposition.
- Implement deterministic salary candidate scoring.
- Implement observed-employer timeline and changes.
- Implement recurring obligation detection.
- Implement self-employed revenue features.

Exit criteria: self-transfers, loans, refunds, and one-offs are excluded from stable income in gold fixtures.

### M6 — circularity and irregularities

- Build temporal multigraph.
- Detect bounded direct and multi-hop cycles.
- Detect split/recombine patterns.
- Add false-positive exclusions.
- Add integrity and robust-statistical irregularity checks.

Exit criteria: every synthetic circularity pattern is detected and every defined legitimate control case remains unflagged or correctly classified.

### M7 — public asynchronous API

- Add multipart submission route.
- Add durable idempotency.
- Add status and authenticated result routes.
- Add provider-neutral errors.
- Add optional callback using existing HMAC conventions.
- Add OpenAPI and portal examples.

Exit criteria: full local API-to-worker journey passes with tenant isolation and no real external providers.

### M8 — reports, hardening, and readiness evidence

- Add authenticated PDF/JSON/Parquet artifact retrieval.
- Add redacted observability.
- Add malware and parser timeout gates.
- Add performance and cost measurement harness.
- Add model/rule/formula version manifest.
- Complete threat-model and privacy review packet.

Exit criteria: local acceptance suite passes; security, privacy, cost, and limitations are documented; no deployment is performed.

## 36. MVP acceptance criteria

The MVP is complete only when all of the following are demonstrated locally:

- one combined PDF can contain multiple banks, accounts, periods, owners, products, and currencies;
- statement segments and coverage are correct;
- all gold monetary values preserve exact decimal precision;
- each ledger reconciles or returns an explicit non-reconciled state;
- overlapping periods do not double-count transactions;
- multi-currency ledgers never mix during reconciliation;
- joint ownership is represented without unsupported income attribution;
- probable self-owned accounts are evidence-backed;
- self-transfers do not inflate consolidated income;
- salary streams and observed employers include confidence, exclusions, and timeline;
- circular cycles return transaction-level evidence and net-new-money impact;
- overdraft and credit facilities remain separate from income and balance;
- irregularities are labeled as signals rather than fraud conclusions;
- every material feature exposes formula/model version and evidence;
- partial results are not decision-eligible by default;
- public errors remain provider-neutral;
- raw statements and report downloads are tenant-authenticated;
- logs contain no raw PII or financial content;
- local tests run without production Azure access; and
- no deployment or merge has occurred.

## 37. Agent working agreement

An implementation agent must follow this sequence:

1. Read this document, the repository root README, and any applicable `AGENTS.md`, security, contribution, workflow, infrastructure, and threat-model documents.
2. Inspect the exact branch, worktree, source SHA, and local changes before editing.
3. Work in an isolated worktree when another agent or unrelated changes occupy the current checkout.
4. Preserve unrelated files and changes.
5. Implement one milestone or narrowly scoped vertical slice at a time.
6. Add or update tests in the same change as behavior.
7. Use synthetic or approved redacted fixtures only.
8. Keep provider responses private and public contracts provider-neutral.
9. Do not add secrets, API keys, real statements, signed URLs, or account data to source or logs.
10. Do not weaken tenant isolation, authentication, network controls, retention, logging caps, or cost guards to make a test pass.
11. Do not introduce an LLM, model, or third-party provider without documenting purpose, data flow, cost, failure behavior, and validation.
12. Do not introduce a credit-decision score during the MVP.
13. Verify exact accounting invariants, not only snapshot JSON.
14. Report source existence, local test success, CI status, retained artifacts, deployment state, and live verification as separate facts.
15. Never claim production readiness from a health endpoint or local test.
16. Do not deploy, merge, create cloud resources, modify RBAC, or alter production configuration without separate explicit authorization.

Every implementation handoff should report:

- branch and source SHA;
- files changed;
- commands and tests run;
- test results;
- supported and unsupported statement cases;
- security, privacy, cost, and performance impact;
- model/rule/schema versions;
- mutations performed, explicitly including none; and
- next safe milestone.

## 38. Initial implementation decisions

The first agent should adopt these decisions unless repository evidence requires a documented change:

- Direct file upload only; no remote statement URL.
- Asynchronous job contract with HTTP 202.
- Separate Python worker; no OCR dependencies in the Node API image.
- Native PDF text fast path.
- Provider-neutral extractor interface.
- Azure Layout adapter plus deterministic local stub.
- RapidOCR/ONNX adapter as private fallback, not mandatory for the first contract-only change.
- Pydantic canonical models using `Decimal`.
- Polars for transaction computations.
- NetworkX bounded cycles for MVP circularity.
- Rules before supervised models.
- No general-purpose LLM in the processing path.
- No credit score in the MVP.
- Authenticated tenant-scoped artifact downloads.
- Synthetic fixture suite before bank-specific expansion.

## 39. Open decisions requiring owner or compliance input

These must not be guessed by an implementation agent:

- approved raw and derived data retention;
- legal basis and consent wording;
- whether managed Document Intelligence processing is approved and in which region;
- approved BSA per-request or per-page cost ceiling;
- maximum public upload size and page count;
- whether direct callbacks are required in the MVP;
- whether PDF audit reports are required in the first release;
- whether customers may request consolidated FX reporting;
- approved transaction taxonomy and prohibited-use categories;
- lender-specific affordability and DBR policy;
- required AECB or other credit-bureau integration boundary;
- manual-review workflow and appeal ownership;
- acceptable confidence and reconciliation thresholds; and
- production retention, legal hold, and deletion behavior.

## 40. Future enhancements

After the MVP and governance gates:

- UAE Open Finance ingestion using ISO 20022-aligned fields;
- approved AECB integration;
- bank-specific custom neural extraction models;
- customer/supplier graphs for SMEs;
- longitudinal monitoring after origination;
- portfolio-level drift and concentration monitoring;
- customer-readable explanation report;
- reviewed lender-specific scorecards;
- challenger models and champion promotion workflow;
- approved human-review workspace; and
- open-banking corroboration of account ownership and balances.

## 41. References

- [CBUAE Responsible Financing Practice](https://rulebook.centralbank.ae/en/rulebook/article-5-responsible-financing-practice)
- [CBUAE Consumer Protection Standards](https://rulebook.centralbank.ae/en/rulebook/consumer-protection-standards)
- [CBUAE Credit Risk Management Standards](https://rulebook.centralbank.ae/en/rulebook/credit-risk-management-standards)
- [CBUAE Model Management Standards](https://rulebook.centralbank.ae/en/node/4881)
- [CBUAE Open Finance Regulation](https://rulebook.centralbank.ae/en/rulebook/open-finance-regulation)
- [UAE Federal Decree-Law No. 45 of 2021 concerning Personal Data Protection](https://www.uaelegislation.gov.ae/en/legislations/1972/download)
- [ISO 20022 Bank-to-Customer Cash Management messages](https://www.iso20022.org/iso-20022-message-definitions?search=Bank-to-Customer+Cash+Management)
- [Azure Document Intelligence Layout](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0)
- [Azure Document Intelligence prebuilt-model language and locale support](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support-prebuilt?tabs=languages%2Cthermal&view=doc-intel-4.0.0)
- [Azure Document Intelligence privacy and security](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/document-intelligence/data-privacy-security)
- [RapidOCR installation](https://github.com/RapidAI/RapidOCRDocs/blob/main/docs/install_usage/rapidocr/install.en.md)
- [PaddleOCR multilingual recognition](https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html)
- [Sentence Transformers multilingual models](https://sbert.net/docs/sentence_transformer/pretrained_models.html)
- [NetworkX bounded cycle detection](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.cycles.simple_cycles.html)
- [Polars lazy API](https://docs.pola.rs/user-guide/concepts/lazy-api/)
- [MLflow Model Registry](https://mlflow.org/docs/latest/model-registry)
