"""Transparent statement-based review measures, never a credit decision.

Every computed value stays within one owned, reconciled account and currency.
Thresholds below prioritize human review; they are not lender policy limits.
"""

from calendar import monthrange
from collections import defaultdict
from decimal import Decimal
from statistics import median


VERSION = "statement-review-models-v1.0.0"
MODEL_IDS = (
    "observed_repayment_ratio", "residual_cash_flow", "income_variability",
    "liquidity_runway", "uae_dbr", "business_dscr",
)
CATALOG = {
    "observed_repayment_ratio": {
        "name": "Observed repayment-to-salary ratio",
        "formula": "Observed monthly loan and card repayments / stable salary candidate",
        "source": "https://rulebook.centralbank.ae/en/rulebook/article-7-repayment-installments",
        "limitation": "This is not the UAE debt burden ratio: statements may omit other liabilities and salary is unverified.",
    },
    "residual_cash_flow": {
        "name": "Residual monthly cash flow",
        "formula": "Candidate external credits - (gross debits - paired self-transfer debits), per complete account-month",
        "source": "https://files.consumerfinance.gov/f/documents/cfpb_interagency-statement_alternative-data.pdf",
        "limitation": "Candidate credits can include unverified income; account-months are not consolidated borrower cash flow.",
    },
    "income_variability": {
        "name": "Income variability",
        "formula": "Population standard deviation of candidate external monthly credits / their mean",
        "source": "https://files.consumerfinance.gov/f/documents/cfpb_interagency-statement_alternative-data.pdf",
        "limitation": "Candidate credits are not verified income; at least three complete months are required.",
    },
    "liquidity_runway": {
        "name": "Observed liquidity runway",
        "formula": "Maximum of zero and minimum booked daily balance / (median non-transfer monthly debits / 30)",
        "source": "https://files.consumerfinance.gov/f/documents/cfpb_interagency-statement_alternative-data.pdf",
        "limitation": "Booked balances do not establish available funds or future expenses.",
    },
    "uae_dbr": {
        "name": "Regulatory debt burden ratio",
        "formula": "Verified total monthly debt repayments / verified gross regular monthly income",
        "source": "https://rulebook.centralbank.ae/en/rulebook/article-7-responsible-financing-practice",
        "limitation": "Requires independent income, all liabilities and Credit Information Agency verification.",
    },
    "business_dscr": {
        "name": "Business debt-service coverage ratio",
        "formula": "Verified cash available for debt service / verified total debt service",
        "source": "https://www.fdic.gov/risk-management-manual-examination-policies/commercial-and-industrial-lending",
        "limitation": "A bank statement alone does not verify operating cash flow or all debt service.",
    },
}


def _value(money: dict | None) -> Decimal:
    return Decimal((money or {}).get("value", "0"))


def _full_month(month: str, segments: list[dict], account_id: str, currency: str) -> bool:
    try:
        year, number = map(int, month.split("-"))
        first = f"{year:04d}-{number:02d}-01"
        last = f"{year:04d}-{number:02d}-{monthrange(year, number)[1]:02d}"
    except (ValueError, IndexError):
        return False
    return any(segment.get("accountId") == account_id and segment.get("currency") == currency
               and segment.get("ownershipType") == "sole" and segment.get("ledgerNature") == "asset"
               and segment.get("reconciliation", {}).get("status") == "fully_reconciled"
               and segment.get("periodStart", "") <= first and segment.get("periodEnd", "") >= last
               for segment in segments)


def _measure(value: Decimal | None, unit: str, *, precision: int = 2) -> dict | None:
    if value is None:
        return None
    return {"value": f"{value:.{precision}f}", "unit": unit}


def _highlight(code: str, priority: str, title: str, explanation: str, action: str,
               *, account_id: str | None = None, currency: str | None = None,
               source_transaction_ids: list[str] | None = None,
               source_segment_ids: list[str] | None = None) -> dict:
    return {"code": code, "reviewPriority": priority, "title": title,
            "explanation": explanation, "suggestedReview": action,
            "accountId": account_id, "currency": currency,
            "sourceTransactionIds": source_transaction_ids or [],
            "sourceSegmentIds": source_segment_ids or [],
            "fraudConclusion": False, "creditDecision": None, "methodVersion": VERSION}


def assess(result: dict, requested: list[str] | None = None) -> dict:
    selected = [model for model in MODEL_IDS if model in set(requested or [])]
    computed = [model for model in MODEL_IDS if model in selected or model in {"residual_cash_flow", "income_variability"}]
    segments = result.get("segments", [])
    accounts = {(item["accountId"], currency): item for item in result.get("accounts", [])
                for currency in item.get("ledgerCurrencies", [])}
    monthly = defaultdict(list)
    for row in result.get("monthlyCashFlow", []):
        key = (row["accountId"], row["currency"])
        if (key in accounts and accounts[key].get("ledgerNature") == "asset"
                and accounts[key].get("ownershipType") == "sole"
                and _full_month(row["month"], segments, *key)):
            monthly[key].append(row)
    liquid = {(row["accountId"], row["currency"]): row for row in result.get("liquidity", [])}
    salary_account = {}
    for segment in segments:
        for transaction in segment.get("transactions", []):
            salary_account[transaction["transactionId"]] = segment["accountId"]
    models = []
    for model_id in computed:
        definition = CATALOG[model_id]
        observations = []
        if model_id in {"uae_dbr", "business_dscr"}:
            models.append({"modelId": model_id, **definition, "status": "requires_external_verification",
                           "observations": [], "missingInputs": ["verified_income_or_operating_cash_flow",
                                                                "complete_debt_obligations"],
                           "decisionEligible": False, "version": VERSION})
            continue
        for (account_id, currency), rows in sorted(monthly.items()):
            rows = sorted(rows, key=lambda item: item["month"])
            transaction_ids = sorted({tid for row in rows for tid in row.get("sourceTransactionIds", [])})
            base = {"accountId": account_id, "currency": currency,
                    "months": [row["month"] for row in rows], "sourceTransactionIds": transaction_ids,
                    "sourceSegmentIds": sorted({segment["statementSegmentId"] for segment in segments
                                                if segment.get("accountId") == account_id and segment.get("currency") == currency}),
                    "value": None, "status": "insufficient_data"}
            if model_id == "residual_cash_flow" and len(rows) >= 2:
                values = [_value(row.get("candidateExternalCredits")) - _value(row.get("grossDebits"))
                          + _value(row.get("selfTransferDebits")) for row in rows]
                base.update(status="observed", value=_measure(median(values), currency),
                            worstObservedMonth=_measure(min(values), currency),
                            negativeMonths=sum(value < 0 for value in values))
            elif model_id == "income_variability" and len(rows) >= 3:
                values = [_value(row.get("candidateExternalCredits")) for row in rows]
                mean = sum(values) / Decimal(len(values))
                if mean > 0:
                    variance = sum((value - mean) ** 2 for value in values) / Decimal(len(values))
                    base.update(status="observed", value=_measure(variance.sqrt() / mean, "ratio", precision=4),
                                meanMonthlyCandidateCredits=_measure(mean, currency))
            elif model_id == "observed_repayment_ratio":
                salary = [item for item in result.get("features", {}).get("salaryStreams", [])
                          if item.get("currency") == currency and item.get("stable")
                          and any(salary_account.get(tid) == account_id for tid in item.get("includedTransactionIds", []))]
                repayments = [item for item in result.get("observedObligations", [])
                              if item.get("accountId") == account_id and item.get("currency") == currency
                              and item.get("category") in {"loan_repayment", "credit_card_payment"}
                              and item.get("frequency") == "monthly_candidate"]
                income = sum((_value(item.get("candidateMonthlyAmount")) for item in salary), Decimal(0))
                debt = sum((_value(item.get("typicalAmount")) for item in repayments), Decimal(0))
                if income > 0 and repayments:
                    base.update(status="observed", value=_measure(debt / income, "ratio", precision=4),
                                observedMonthlyRepayments=_measure(debt, currency),
                                stableSalaryCandidate=_measure(income, currency),
                                sourceTransactionIds=sorted(set(transaction_ids) | {
                                    tid for item in repayments for tid in item.get("transactionIds", [])}))
            elif model_id == "liquidity_runway" and len(rows) >= 2 and (account_id, currency) in liquid:
                debits = [_value(row.get("grossDebits")) - _value(row.get("selfTransferDebits")) for row in rows]
                typical = median(debits)
                if typical > 0:
                    minimum = _value(liquid[(account_id, currency)].get("minimumDailyBalance"))
                    base.update(status="observed", value=_measure(max(Decimal(0), minimum) / (typical / 30), "days"),
                                minimumBookedBalance=_measure(minimum, currency),
                                medianMonthlyNonTransferDebits=_measure(typical, currency),
                                negativeBalanceDays=liquid[(account_id, currency)].get("negativeBalanceDays", 0))
            observations.append(base)
        models.append({"modelId": model_id, **definition,
                       "status": "observed" if any(item["status"] == "observed" for item in observations)
                       else "insufficient_data", "observations": observations,
                       "decisionEligible": False, "version": VERSION})

    highlights = []
    unsupported = result.get("coverage", {}).get("unsupportedPages", [])
    if unsupported:
        highlights.append(_highlight("UNSUPPORTED_PAGES", "high", "Some pages were not analyzed",
                                     f"{len(unsupported)} page(s) lack a reliable ledger extraction.",
                                     "Check the source pages or request a clearer statement."))
    for segment in segments:
        if segment.get("reconciliation", {}).get("status") != "fully_reconciled":
            highlights.append(_highlight("UNRECONCILED_LEDGER", "high", "Ledger does not reconcile",
                                         "The transaction arithmetic does not match the reported balances.",
                                         "Compare the cited rows and balances with the original statement.",
                                         account_id=segment.get("accountId"), currency=segment.get("currency"),
                                         source_segment_ids=[segment["statementSegmentId"]]))
    for item in result.get("liquidity", []):
        if item.get("negativeBalanceDays", 0) > 0:
            highlights.append(_highlight("NEGATIVE_BALANCE_DAYS", "medium", "Negative booked balance observed",
                                         f"The account had {item['negativeBalanceDays']} negative-balance day(s).",
                                         "Review overdraft terms and whether the balance was available or booked.",
                                         account_id=item["accountId"], currency=item["currency"],
                                         source_segment_ids=item.get("sourceSegmentIds", [])))
    for model in models:
        if model["modelId"] == "residual_cash_flow":
            for item in model["observations"]:
                account_rows = monthly[(item["accountId"], item["currency"])]
                externally_funded_months = sum(_value(row.get("candidateExternalCredits")) > 0 for row in account_rows)
                if item.get("negativeMonths", 0) >= 2 and externally_funded_months >= 2:
                    highlights.append(_highlight("REPEATED_NEGATIVE_MONTHLY_CASH_FLOW", "medium",
                                                 "Repeated monthly cash deficit",
                                                 f"{item['negativeMonths']} complete observed months had more non-transfer debits than candidate external credits.",
                                                 "Verify expenses, missing accounts and other income sources.",
                                                 account_id=item["accountId"], currency=item["currency"],
                                                 source_transaction_ids=item["sourceTransactionIds"],
                                                 source_segment_ids=item["sourceSegmentIds"]))
        if model["modelId"] == "income_variability":
            for item in model["observations"]:
                if item["value"] and Decimal(item["value"]["value"]) >= Decimal("0.40"):
                    highlights.append(_highlight("VARIABLE_CANDIDATE_CREDITS", "medium",
                                                 "Monthly credits vary substantially",
                                                 f"Observed coefficient of variation is {Decimal(item['value']['value']) * 100:.1f}% across {len(item['months'])} months.",
                                                 "Verify payer, purpose and income continuity.",
                                                 account_id=item["accountId"], currency=item["currency"],
                                                 source_transaction_ids=item["sourceTransactionIds"]))
    for item in result.get("irregularities", []):
        mapping = {"SALARY_PAYMENT_GAP": ("Salary payment gap", "Check employment and missing statement periods."),
                   "LARGE_CREDIT_OUTLIER": ("Large credit outlier", "Verify payer and purpose before counting it as income."),
                   "DUPLICATE_STATEMENT_PAGE": ("Duplicate statement page", "Review source page order and overlap.")}
        if item.get("signal") in mapping:
            title, action = mapping[item["signal"]]
            explanation = {
                "SALARY_PAYMENT_GAP": f"An observed payer is absent in {item.get('missingMonths', 0)} month(s) within the statement span.",
                "LARGE_CREDIT_OUTLIER": "A credit is unusually large compared with other credits in this account and currency.",
                "DUPLICATE_STATEMENT_PAGE": f"Page {item.get('duplicatePage', '?')} repeats page {item.get('firstPage', '?')}; duplicate rows were removed from analytics.",
            }[item["signal"]]
            highlights.append(_highlight(item["signal"], "medium", title,
                                         explanation,
                                         action, account_id=item.get("accountId"), currency=item.get("currency"),
                                         source_transaction_ids=item.get("transactionIds", [])))
    if result.get("circularFlows"):
        highlights.append(_highlight("CIRCULAR_SELF_TRANSFERS", "medium", "Funds returned to the origin",
                                     "Paired account transfers include a cycle; these credits are excluded from income.",
                                     "Confirm account ownership and transfer purpose."))
    if not highlights:
        highlights.append(_highlight("NO_AUTOMATED_REVIEW_SIGNAL", "info", "No automated pattern flagged",
                                     "The current rules did not identify a review trigger in the extracted data.",
                                     "Continue normal verification of the statement and applicant."))
    return {"version": VERSION, "purpose": "decision_support_only", "creditDecision": None,
            "decisionEligible": False, "requestedModels": selected,
            "models": [model for model in models if model["modelId"] in selected],
            "riskHighlights": highlights,
            "limitations": ["No applicant eligibility, credit score or fraud finding is produced.",
                            "Debt and income completeness require independent verification.",
                            "Review priorities are demo heuristics, not lender policy thresholds."]}
