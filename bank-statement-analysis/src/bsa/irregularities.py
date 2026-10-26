"""Review signals only. These findings are never fraud or credit decisions."""

import hashlib
from collections import defaultdict
from decimal import Decimal
from statistics import median

from .contracts import Segment, Transaction


VERSION = "irregularities-v1.0.0"


def document_page_duplicates(pages: list[str]) -> list[dict]:
    seen = {}
    groups = []
    for number, text in enumerate(pages, 1):
        if not text.strip():
            continue
        fingerprint = hashlib.sha256(" ".join(text.split()).encode()).hexdigest()
        if fingerprint in seen:
            groups.append({"firstPage": seen[fingerprint], "duplicatePage": number,
                           "signal": "DUPLICATE_STATEMENT_PAGE", "fraudConclusion": False,
                           "method": VERSION})
        else:
            seen[fingerprint] = number
    return groups


def financial_signals(observed: list[tuple[Segment, Transaction]],
                      liquidity: list[dict], employers: list[dict]) -> list[dict]:
    signals = []
    credits = defaultdict(list)
    for segment, transaction in observed:
        if segment.ledgerNature != "asset" or segment.reconciliation["status"] != "fully_reconciled":
            continue
        if transaction.creditDebitIndicator == "CREDIT":
            credits[(segment.accountId, segment.currency)].append(transaction)
    for (account_id, currency), rows in credits.items():
        values = [Decimal(row.ledgerAmount.value) for row in rows]
        if len(values) < 5:
            continue
        center = median(values)
        mad = median([abs(value - center) for value in values])
        for row in rows:
            value = Decimal(row.ledgerAmount.value)
            if (mad > 0 and value > center + 6 * mad) or (mad == 0 and center > 0 and value > center * 4):
                signals.append({"signal": "LARGE_CREDIT_OUTLIER", "accountId": account_id,
                                "currency": currency, "transactionIds": [row.transactionId],
                                "method": VERSION, "fraudConclusion": False,
                                "evidence": [item.model_dump() for item in row.evidence]})
    for item in liquidity:
        if item["negativeBalanceDays"]:
            signals.append({"signal": "NEGATIVE_BOOKED_BALANCE_OBSERVED", "accountId": item["accountId"],
                            "currency": item["currency"], "observedDays": item["negativeBalanceDays"],
                            "sourceSegmentIds": item["sourceSegmentIds"], "method": VERSION,
                            "fraudConclusion": False})
    for item in employers:
        if item["missingMonthsInSpan"]:
            signals.append({"signal": "SALARY_PAYMENT_GAP", "currency": item["currency"],
                            "missingMonths": item["missingMonthsInSpan"],
                            "transactionIds": item["transactionIds"], "method": VERSION,
                            "fraudConclusion": False})
    return signals
