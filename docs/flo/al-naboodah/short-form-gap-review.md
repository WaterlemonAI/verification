# Al Naboodah supplier journey: gap and automation review

Reviewed 20 November 2026 against the commented supplier questionnaire, the local `decision13-workflow.json`, Flo routes/processor, and the FTA's Decision 13. This is an implementation review of the unpublished draft, not a compliance sign-off. Article 3 supplier verification, Article 4 supply verification, and Al Naboodah's own reminder/freshness rules are separate controls.

## Current minimum path

| Path | Required form answers before OCR or buyer prefill | Required uploads | Other supplier action |
|---|---:|---:|---|
| Natural person, services, no exceptions | 12 | ID/passport; bank letter | Sample-terms consent and video slot |
| UAE company, services, no exceptions | 14 | Trade licence; representative ID/passport; bank letter | Sample-terms consent |
| Foreign company, services, no exceptions | 13 | Incorporation record; representative ID/passport; home-country or UAE bank letter | Sample-terms consent |

The number is the count of required visible fields in the JSON schema. OCR prefills some answers in the browser, but the schema still renders them as required controls. Goods, changed address/personnel, foreign-account, cash, third-party and intermediary branches add questions.

## Release-blocking gaps, in priority order

1. **Buyer verification gate:** The acceptance route blocks an unconfirmed natural-person meeting, but does not require a recorded independent place-of-business check, suitability assessment, representative identity/authority check, resolution of material risk findings, or an exception decision. Reviewer roles and supervisor approval are not enforced for these conclusions. A supplier's `operating_address_same=Yes` and an uploaded document are claims/evidence, not an independent Article 3(2) result.
2. **Document validity:** The server rejects expired dates typed by the supplier, but does not compare those dates with OCR dates before acceptance. The generic passport/Emirates-ID path uses Gemini extraction; it does not authenticate the ID or prove it remains active. A supplier could type a future date for an expired uploaded document. OCR disagreement needs a buyer-resolution path rather than silently accepting either value.
3. **Spend and enhanced measures:** There is no Al Naboodah supplier-ID join, previous-12-month ledger, or next-12-month forecast. Flo collects a bank letter and runs adverse media for everyone, but cannot flag when Article 3(4) applies or attest the UAE-authorised bank, absence of relevant reservations, client recommendations where available, and public-review assessment. A foreign home-country letter is useful evidence but does not automatically satisfy the UAE-bank wording at the threshold.
4. **Check applicability and decisions:** `ejari-verification` is selected globally while Ejari upload is optional, so non-Dubai/no-Ejari cases receive an unavailable result. Other unavailable, partial, mismatched, or adverse results do not block the buyer's Accept action or require a recorded resolution. Each check needs `passed`, `failed`, `unavailable`, or `not applicable` with source and reviewer; acceptance needs a policy decision over those states.
5. **Buyer systems and lifecycle:** No current verified-document reuse or dynamic request list is connected. The 11th-month renewal and one-month-before-expiry reminders remain in the separate monitoring workflow, and per-supply Article 4 checks remain in the order/invoice workflow. Those systems need to pass their status to procurement/AP before first supply and input-tax deduction.

## Shorten the supplier journey without discarding evidence

| Current supplier step | Automate from | Ask the supplier only when |
|---|---|---|
| Supplier type and UAE/foreign branch | Al Naboodah vendor master and document classification | Type or jurisdiction is missing or conflicts with the uploaded document |
| Legal name, licence/registration number, jurisdiction, licensed activities | Trade-licence/COI OCR followed by TLV or registry review | OCR or verification is missing, ambiguous or inconsistent |
| ID details and expiry | Current verified document on file, or ID/passport OCR | A new document is required; keep the separate supplier expiry confirmation required by Al Naboodah |
| Website and supplier sectors | Vendor master, trade licence, merchant screening | No reliable source exists and the buyer needs these facts for risk assessment |
| IBAN, account holder, bank/branch/country and letter date | Bank-letter OCR, existing verified payment record and IBAN check | A field is unreadable or conflicts; never treat OCR as proof of bank issuance |
| “Account outside registration country?” | Compare normalized bank country with verified registration/residence country | Country cannot be determined or a mismatch needs a commercial explanation |
| Proposed goods/services, normal activity and volume | Requisition/PO, supplier master, licence activity, merchant results and prior purchases | Proposed work differs materially from the verified activity or capacity |
| Cash, third-party payee, offshore account, intermediary, goods origin/right to sell | PO, contract, AP/payment instructions and order-level evidence | An arrangement or specific supply actually triggers that Article 4 exception |
| Address and repeated changes | Licence, Ejari/utility/deed, registry/history, merchant observations, buyer visit/video record | Actual operating address or relevant change history cannot be established; retain one confirmation if evidence is weak |

**Recommended shortest supplier path:** show a branch-specific checklist with only missing/current documents; run extraction and provider checks before showing the answer stage; display an evidence summary for confirmation; ask separate expiry dates, actual-address or change exceptions, and any unresolved payment/supply anomalies. Keep video-slot selection for a natural person. Move transaction-specific questions to the order workflow; do not simply delete their control.

## Target processing order

1. Buyer issues invitation with supplier ID, legal party, expected supply category, known website/payment route and spend context. Resolve reusable verified documents by supplier ID, legal name, document type, expiry and provenance.
2. Supplier supplies only missing documents. OCR records extracted facts; TLV, identity, IBAN, merchant, Ejari and screening APIs run on those facts where applicable. A provider result is stored separately from OCR and supplier corrections.
3. A discrepancy engine creates only targeted supplier questions. The buyer records actual/suitable premises, representative authority, risk explanations, threshold calculation, bank-letter review and public-reputation conclusion. Failed/unavailable checks remain visible.
4. The buyer's documented approval gate precedes first supply. AP/tax receives the supplier-verification date and status; an order/invoice flow records Article 4 checks and the Article 6 exception where relevant. Monitoring sends Al Naboodah's 11th-month and document-expiry reminders.

## Comment reconciliation

The embedded comments are accounted for by natural-person terminology and early ID collection; a home-country bank-account/letter path; activity fit for natural persons; and goods origin/right-to-sell evidence. The “supplier sectors” comment is not an active field in the shortened schema. It can be populated from merchant screening or vendor master; ask it only when the buyer needs it and neither source is reliable. The goods origin/right-to-sell prompts currently appear in the supplier form even though they are more accurately attached to each goods order.

Sources: [FTA Decision 13](https://tax.gov.ae/en/content/fta.decision.no.13.of.2026.on.measures.procedures.conditions.required.by.taxable.persons.for.verification.of.validity.and.integrity.of.supplies.aspx) and [FTA public clarification listing, updated 11 November 2026](https://tax.gov.ae/en/taxes/vat/guides.references.aspx). The FTA English decision is labelled an unofficial translation.
