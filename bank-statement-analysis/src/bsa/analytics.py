"""Exact, lender-neutral features derived only from canonical reconciled ledgers.

Every monetary aggregate is partitioned by ledger currency. Classification
rules are deliberately conservative and expose their source transaction IDs.
"""

import re
import unicodedata
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from statistics import median

from .contracts import Account, Balance, Facility, Money, Owner, Segment, Transaction


VERSION = "analytics-v1.0.0"
ARABIC_MARKS = re.compile(r"[\u064b-\u065f\u0670\u06d6-\u06ed]")
SPACE = re.compile(r"\s+")
REFERENCE = re.compile(r"\b(?:ref|reference|txn|transaction|ft)\s*[:#-]?\s*[a-z0-9-]{4,}\b", re.I)
LEGAL_SUFFIX = re.compile(r"\b(?:llc|ltd|pjsc|fze|fzco|limited|company|co)\b", re.I)
OBLIGATION_TERMS = {
    "rent": ("rent", "rental", "إيجار"),
    "loan_repayment": ("loan repayment", "emi", "instalment", "installment", "قسط"),
    "credit_card_payment": ("credit card payment", "card repayment", "بطاقة ائتمان"),
    "utilities": ("utility", "electricity", "water bill", "dewa", "sewa", "كهرباء"),
    "telecom": ("telecom", "mobile bill", "internet bill", "اتصالات"),
    "insurance": ("insurance", "تأمين"),
    "education": ("school fee", "tuition", "رسوم مدرسية"),
    "standing_order": ("standing order", "direct debit", "أمر دائم"),
}
NON_INCOME_TERMS = {
    "loan_proceeds": ("loan", "disbursement", "advance", "قرض"),
    "refund_or_reversal": ("refund", "reversal", "chargeback", "استرداد"),
    "cash_deposit": ("cash deposit", "cdm", "إيداع نقدي"),
}


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = ARABIC_MARKS.sub("", value)
    value = value.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))
    value = value.translate(str.maketrans("أإآٱى", "ااااي"))
    value = REFERENCE.sub(" ", value)
    value = LEGAL_SUFFIX.sub(" ", value)
    return SPACE.sub(" ", "".join(character if character.isalnum() or character.isspace() else " " for character in value)).strip()


def money(value: Decimal, currency: str, scale: int) -> dict:
    return Money(value=f"{value:.{scale}f}", currency=currency, scale=scale).model_dump()


def _signed(transaction: Transaction) -> Decimal:
    value = Decimal(transaction.ledgerAmount.value)
    return value if transaction.creditDebitIndicator == "CREDIT" else -value


def canonical_accounts(segments: list[Segment]) -> tuple[list[dict], list[dict], list[dict]]:
    accounts = {}
    balances = []
    facilities = []
    for segment in segments:
        key = segment.accountId
        owner_name = normalize_name(segment.ownerName)
        owner = Owner(ownerId=f"owner_{key[4:]}", nameRaw=segment.ownerName,
                      nameNormalized=owner_name,
                      role="joint_owner" if segment.ownershipType == "joint" else
                           ("owner" if segment.ownershipType == "sole" else "unknown"),
                      attributionConfidence=0.7 if segment.ownershipType == "sole" else 0.0)
        if key not in accounts:
            accounts[key] = Account(accountId=key, bankId=segment.bankId,
                                    accountNumberMasked=segment.accountNumberMasked,
                                    accountFingerprint=segment.accountFingerprint or f"sha256:{key.removeprefix('acc_')}",
                                    productType=segment.productType, ledgerNature=segment.ledgerNature,
                                    ownershipType=segment.ownershipType, owners=[owner],
                                    ledgerCurrencies=[segment.currency])
        elif segment.currency not in accounts[key].ledgerCurrencies:
            accounts[key].ledgerCurrencies.append(segment.currency)
        for kind, source, as_of in (("opening_booked", segment.openingBalance, segment.periodStart),
                                    ("closing_booked", segment.closingBalance, segment.periodEnd)):
            value = Decimal(source.value)
            balances.append(Balance(balanceId=f"bal_{segment.statementSegmentId}_{kind}",
                                    type=kind, amount=source,
                                    creditDebitIndicator="CREDIT" if value >= 0 else "DEBIT",
                                    canonicalSignedValue=source.value, asOf=as_of,
                                    sourceLabel=kind.replace("_", " "),
                                    evidence=segment.openingEvidence if kind == "opening_booked" else segment.closingEvidence).model_dump())
        facility_type = "credit_card" if segment.productType == "credit_card" else (
            "loan" if segment.productType == "loan" else
            ("overdraft" if segment.reportedFacilityLimit is not None else None))
        if facility_type:
            utilized_value = max(Decimal(0), -Decimal(segment.closingBalance.value))
            utilized = Money.model_validate(money(utilized_value, segment.currency, segment.closingBalance.scale))
            available = None
            if segment.reportedFacilityLimit is not None:
                limit_value = Decimal(segment.reportedFacilityLimit.value)
                available = Money.model_validate(money(max(Decimal(0), limit_value - utilized_value),
                                                      segment.currency, segment.closingBalance.scale))
            facilities.append(Facility(facilityType=facility_type, accountId=key,
                                       limit=segment.reportedFacilityLimit, utilized=utilized,
                                       available=available, calculationMethod="derived_from_reported_limit_and_booked_balance",
                                       evidence=segment.facilityEvidence or segment.closingEvidence).model_dump())
    return [item.model_dump() for item in accounts.values()], balances, facilities


def daily_balances(segments: list[Segment]) -> tuple[list[dict], list[str]]:
    """Fill each calendar day from booked opening to booked closing, retaining conflicts."""
    days = {}
    conflicts = set()
    for segment in segments:
        if segment.reconciliation["status"] != "fully_reconciled":
            continue
        grouped = defaultdict(list)
        for transaction in segment.transactions:
            grouped[transaction.bookingDate].append(transaction)
        cursor = date.fromisoformat(segment.periodStart)
        end = date.fromisoformat(segment.periodEnd)
        if (end - cursor).days > 370:
            continue
        balance = Decimal(segment.openingBalance.value)
        while cursor <= end:
            day = cursor.isoformat()
            for transaction in grouped[day]:
                balance += _signed(transaction)
            key = (segment.accountId, segment.currency, day)
            if key in days and days[key]["value"] != balance:
                conflicts.add(key)
            else:
                days[key] = {"accountId": segment.accountId, "currency": segment.currency,
                             "date": day, "value": balance, "scale": segment.openingBalance.scale,
                             "segmentIds": sorted(set([*days.get(key, {}).get("segmentIds", []), segment.statementSegmentId]))}
            cursor += timedelta(days=1)
    for key in conflicts:
        days.pop(key, None)
    records = [{**{field: value for field, value in record.items() if field not in {"value", "scale"}},
                "balance": money(record["value"], record["currency"], record["scale"])}
               for _, record in sorted(days.items())]
    return records, sorted({"BALANCE_CONFLICT_IN_OVERLAP"} if conflicts else set())


def liquidity(daily: list[dict], accounts: list[dict]) -> list[dict]:
    grouped = defaultdict(list)
    asset_ids = {account["accountId"] for account in accounts if account["ledgerNature"] == "asset"}
    for record in daily:
        if record["accountId"] not in asset_ids:
            continue
        grouped[(record["accountId"], record["currency"])].append(record)
    outputs = []
    for (account_id, currency), records in sorted(grouped.items()):
        values = [Decimal(item["balance"]["value"]) for item in records]
        scale = records[0]["balance"]["scale"]
        outputs.append({"accountId": account_id, "currency": currency,
                        "observedDays": len(values),
                        "averageDailyBalance": money(sum(values) / len(values), currency, scale),
                        "minimumDailyBalance": money(min(values), currency, scale),
                        "maximumDailyBalance": money(max(values), currency, scale),
                        "negativeBalanceDays": sum(value < 0 for value in values),
                        "endOfMonthBalances": [{"month": item["date"][:7], "balance": item["balance"]}
                                               for index, item in enumerate(records)
                                               if index == len(records) - 1 or records[index + 1]["date"][:7] != item["date"][:7]],
                        "formulaVersion": VERSION,
                        "sourceSegmentIds": sorted({id for item in records for id in item["segmentIds"]})})
    return outputs


def obligations(transactions: list[tuple[Segment, Transaction]], excluded_ids: set[str]) -> list[dict]:
    groups = defaultdict(list)
    for segment, transaction in transactions:
        if (segment.ledgerNature != "asset" or segment.ownershipType != "sole" or
                segment.reconciliation["status"] != "fully_reconciled" or
                transaction.creditDebitIndicator != "DEBIT" or transaction.transactionId in excluded_ids):
            continue
        description = normalize_name(transaction.descriptionRaw)
        category = next((name for name, terms in OBLIGATION_TERMS.items()
                         if any(normalize_name(term) in description for term in terms)), None)
        if category is None:
            continue
        counterparty = normalize_name(transaction.counterpartyRaw)
        groups[(segment.accountId, segment.currency, category, counterparty)].append(transaction)
    outputs = []
    for (account_id, currency, category, counterparty), rows in sorted(groups.items()):
        months = sorted({row.bookingDate[:7] for row in rows})
        values = [Decimal(row.ledgerAmount.value) for row in rows]
        scale = rows[0].ledgerAmount.scale
        outputs.append({"accountId": account_id, "currency": currency, "category": category,
                        "probableCreditor": counterparty or None, "paymentCount": len(rows),
                        "observedMonths": months, "frequency": "monthly_candidate" if len(months) >= 2 else "unconfirmed",
                        "typicalAmount": money(median(values), currency, scale),
                        "minimumAmount": money(min(values), currency, scale),
                        "maximumAmount": money(max(values), currency, scale),
                        "lastObservedDate": max(row.bookingDate for row in rows),
                        "confidence": 0.8 if len(months) >= 3 else (0.6 if len(months) == 2 else 0.3),
                        "transactionIds": [row.transactionId for row in rows],
                        "formulaVersion": VERSION,
                        "limitation": "Observed payments do not establish the outstanding legal liability."})
    return outputs


def monthly_cash_flow(transactions: list[tuple[Segment, Transaction]], excluded_ids: set[str]) -> list[dict]:
    grouped = defaultdict(lambda: {"grossCredits": Decimal(0), "grossDebits": Decimal(0),
                                   "selfTransferCredits": Decimal(0), "selfTransferDebits": Decimal(0),
                                   "candidateExternalCredits": Decimal(0), "unclassifiedCredits": Decimal(0),
                                   "sourceTransactionIds": []})
    for segment, row in transactions:
        if segment.ledgerNature != "asset" or segment.reconciliation["status"] != "fully_reconciled":
            continue
        key = (segment.accountId, segment.currency, row.bookingDate[:7])
        record = grouped[key]
        value = Decimal(row.ledgerAmount.value)
        if row.creditDebitIndicator == "CREDIT":
            record["grossCredits"] += value
            if row.transactionId in excluded_ids:
                record["selfTransferCredits"] += value
            elif segment.ownershipType == "sole":
                description = normalize_name(row.descriptionRaw)
                if any(normalize_name(term) in description for terms in NON_INCOME_TERMS.values() for term in terms):
                    record["unclassifiedCredits"] += value
                else:
                    record["candidateExternalCredits"] += value
            else:
                record["unclassifiedCredits"] += value
        else:
            record["grossDebits"] += value
            if row.transactionId in excluded_ids:
                record["selfTransferDebits"] += value
        record["sourceTransactionIds"].append(row.transactionId)
    outputs = []
    for (account_id, currency, month), record in sorted(grouped.items()):
        scale = next(row.ledgerAmount.scale for segment, row in transactions
                     if segment.accountId == account_id and row.ledgerCurrency == currency)
        outputs.append({"accountId": account_id, "currency": currency, "month": month,
                        **{key: money(value, currency, scale) for key, value in record.items() if isinstance(value, Decimal)},
                        "sourceTransactionIds": record["sourceTransactionIds"], "formulaVersion": VERSION,
                        "limitation": "External credits are candidates until payer and purpose are verified."})
    return outputs


def employer_timeline(salary_streams: list[dict], transactions: list[tuple[Segment, Transaction]]) -> list[dict]:
    indexed = {row.transactionId: row for _, row in transactions}
    result = []
    for stream in salary_streams:
        rows = [indexed[id] for id in stream["includedTransactionIds"] if id in indexed]
        if not rows:
            continue
        dates = sorted(row.bookingDate for row in rows)
        values = [Decimal(row.ledgerAmount.value) for row in rows]
        months = sorted({value[:7] for value in dates})
        first = date.fromisoformat(dates[0])
        last = date.fromisoformat(dates[-1])
        span = (last.year - first.year) * 12 + last.month - first.month + 1
        result.append({"observedEmployer": stream["observedPayer"] or None,
                       "verifiedEmployer": None, "currency": stream["currency"],
                       "firstObservedPayment": dates[0], "lastObservedPayment": dates[-1],
                       "paymentCount": len(rows), "observedMonths": months,
                       "cadence": "monthly_candidate" if len(months) >= 2 else "unknown",
                       "missingMonthsInSpan": max(0, span - len(months)),
                       "medianPayment": money(median(values), stream["currency"], rows[0].ledgerAmount.scale),
                       "minimumPayment": money(min(values), stream["currency"], rows[0].ledgerAmount.scale),
                       "maximumPayment": money(max(values), stream["currency"], rows[0].ledgerAmount.scale),
                       "confidence": stream["confidence"],
                       "transactionIds": stream["includedTransactionIds"], "formulaVersion": VERSION})
    return result


def affordability_candidates(monthly: list[dict], salary_streams: list[dict],
                             observed_obligations: list[dict]) -> list[dict]:
    """Lender-neutral observed inputs, with no DBR threshold or decision."""
    currencies = sorted({item["currency"] for item in monthly})
    outputs = []
    for currency in currencies:
        records = [item for item in monthly if item["currency"] == currency]
        if not records:
            continue
        scale = records[0]["grossCredits"]["scale"]
        stable_candidate = sum((Decimal(stream["candidateMonthlyAmount"]["value"])
                                for stream in salary_streams if stream["currency"] == currency and stream["stable"]),
                               Decimal(0))
        obligation_candidate = sum((Decimal(item["typicalAmount"]["value"])
                                    for item in observed_obligations if item["currency"] == currency and
                                    item["frequency"] == "monthly_candidate"), Decimal(0))
        monthly_net = []
        for item in records:
            inflow = Decimal(item["candidateExternalCredits"]["value"])
            outflow = Decimal(item["grossDebits"]["value"]) - Decimal(item["selfTransferDebits"]["value"])
            monthly_net.append(inflow - outflow)
        outputs.append({"currency": currency,
                        "stableMonthlyIncomeCandidate": money(stable_candidate, currency, scale),
                        "monthlyObservedObligationCandidate": money(obligation_candidate, currency, scale),
                        "averageObservedMonthlySurplusCandidate": money(sum(monthly_net) / len(monthly_net), currency, scale),
                        "worstObservedMonthlySurplusCandidate": money(min(monthly_net), currency, scale),
                        "accountMonths": len(records), "negativeCashFlowAccountMonths": sum(value < 0 for value in monthly_net),
                        "missingDbrInputs": ["verified_existing_liabilities", "remaining_principal",
                                             "finance_cost", "customer_declarations_review"],
                        "decisionEligible": False, "formulaVersion": VERSION,
                        "limitation": "Account-month observations are not consolidated customer-month affordability."})
    return outputs
