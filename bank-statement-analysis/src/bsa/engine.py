"""Conservative reconciliation and analytics over recognized statement ledgers."""

import hashlib
import io
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal
from itertools import islice, product
from statistics import median

import networkx as nx
from pypdf import PdfReader, PdfWriter

from .contracts import Evidence, Money, Segment, Transaction
from .analytics import affordability_candidates, canonical_accounts, daily_balances, employer_timeline, liquidity, monthly_cash_flow, normalize_name, obligations
from .extraction import DocumentInput, ExtractedWord, NativePdfExtractor, Extractor
from .registry import profile
from .irregularities import document_page_duplicates, financial_signals
from .relationships import resolve_accounts
from .identifiers import account_fingerprint


HEADER = profile("ai7-synthetic-v1")["header"]
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CURRENCY_SCALE = {"AED": 2, "USD": 2, "EUR": 2, "GBP": 2, "KWD": 3, "BHD": 3, "OMR": 3, "JPY": 0}


def identifier(prefix: str, *parts: str) -> str:
    raw = "\x1f".join(map(str, parts)).encode()
    return f"{prefix}_{hashlib.sha256(raw).hexdigest()[:18]}"


def amount(value: str, currency: str) -> Money:
    number = Decimal(value.strip().replace(",", ""))
    if not number.is_finite():
        raise ValueError("invalid money")
    scale = CURRENCY_SCALE.get(currency)
    if scale is None or -number.as_tuple().exponent > scale:
        raise ValueError("unknown currency or precision")
    return Money(value=f"{number:.{scale}f}", currency=currency, scale=scale)


def signed(transaction: Transaction) -> Decimal:
    number = Decimal(transaction.ledgerAmount.value)
    return number if transaction.creditDebitIndicator == "CREDIT" else -number


def read_pages(data: bytes) -> list[str]:
    document = NativePdfExtractor().analyze(DocumentInput(documentId="doc_input", data=data))
    return [page.text for page in document.pages]


def _unsupported_runs(pages: list[str], unsupported: list[int]) -> list[list[int]]:
    runs = []
    current = []
    signature = None
    for number in unsupported:
        text = pages[number - 1]
        account = re.search(r"Account\s+Number\s*:?\s*(\d{10,20})", text, re.I)
        period = re.search(r"Statement\s+Period\s*:?\s*(?:From\s+)?([0-9/ -]{10,30})", text, re.I)
        candidate = (account.group(1), period.group(1).strip()) if account and period else None
        boundary = current and (number != current[-1] + 1 or bool(text.strip()) != bool(pages[current[-1] - 1].strip())
                                or (candidate is not None and signature is not None and candidate != signature))
        if boundary:
            runs.append(current)
            current = []
            signature = None
        current.append(number)
        signature = candidate or signature
    if current:
        runs.append(current)
    return runs


def _extract_subset(data: bytes, page_numbers: list[int]) -> bytes:
    source = PdfReader(io.BytesIO(data), strict=True)
    output = PdfWriter()
    for number in page_numbers:
        output.add_page(source.pages[number - 1])
    buffer = io.BytesIO()
    output.write(buffer)
    return buffer.getvalue()


def _restore_page_numbers(segment: Segment, page_numbers: list[int]) -> Segment:
    for transaction in segment.transactions:
        for evidence in transaction.evidence:
            evidence.page = page_numbers[evidence.page - 1]
    for evidence in [*segment.openingEvidence, *segment.closingEvidence, *segment.facilityEvidence]:
        evidence.page = page_numbers[evidence.page - 1]
    segment.pages = page_numbers
    return segment


def parse_page(text: str, page_number: int, document_id: str,
               line_evidence: list[ExtractedWord] | None = None,
               tenant_scope: str | None = None) -> Segment | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0] != HEADER:
        return None
    attributes = {}
    rows = []
    for line in lines[1:]:
        if line.startswith("TXN|"):
            rows.append(line)
        elif ":" in line:
            key, value = line.split(":", 1)
            attributes[key.strip().upper()] = value.strip()
    needed = {"BANK", "ACCOUNT", "OWNER", "OWNERSHIP", "PRODUCT", "CURRENCY", "PERIOD", "OPENING", "CLOSING"}
    if not needed.issubset(attributes):
        raise ValueError("MISSING_STATEMENT_FIELD")
    currency = attributes["CURRENCY"].upper()
    start, end = [part.strip() for part in attributes["PERIOD"].split("..", 1)]
    if not DATE.fullmatch(start) or not DATE.fullmatch(end) or date.fromisoformat(start) > date.fromisoformat(end):
        raise ValueError("INVALID_STATEMENT_PERIOD")
    account = attributes["ACCOUNT"]
    if len(account) > 64 or not account:
        raise ValueError("INVALID_ACCOUNT")
    fingerprint = account_fingerprint(tenant_scope or document_id, attributes["BANK"], account)
    account_id = f"acc_{fingerprint.removeprefix('sha256:')[:18]}"
    segment_id = identifier("seg", document_id, str(page_number))
    layout = line_evidence or []
    def source_evidence(prefix: str, occurrence: int = 0) -> list[Evidence]:
        matches = [item for item in layout if item.text.startswith(prefix)]
        if occurrence >= len(matches):
            return []
        line = matches[occurrence]
        polygon = line.polygon
        return [Evidence(documentId=document_id, statementSegmentId=segment_id, page=page_number,
                         rawText=line.text, extractionMethod="pypdf-native-v1", extractorVersion="pypdf-native-v1",
                         boundingPolygon=polygon,
                         boundingBox=[polygon[0][0], polygon[0][1], polygon[2][0], polygon[2][1]] if polygon else None)]
    opening = amount(attributes["OPENING"], currency)
    closing = amount(attributes["CLOSING"], currency)
    transactions = []
    for index, row in enumerate(rows):
        parts = row.split("|", 7)
        if len(parts) != 8:
            raise ValueError("INVALID_TRANSACTION_ROW")
        _, booking_date, direction, value, running, reference, description, counterparty = parts
        if not DATE.fullmatch(booking_date) or direction not in {"CREDIT", "DEBIT"}:
            raise ValueError("INVALID_TRANSACTION_ROW")
        if not start <= booking_date <= end or Decimal(value) < 0:
            raise ValueError("INVALID_TRANSACTION_ROW")
        matched = source_evidence("TXN|", index)
        evidence = matched[0] if matched else Evidence(documentId=document_id,
                                                       statementSegmentId=segment_id, page=page_number, rawText=row)
        transactions.append(Transaction(
            transactionId=identifier("txn", segment_id, str(index)), accountId=account_id,
            ledgerCurrency=currency, bookingDate=booking_date, creditDebitIndicator=direction,
            ledgerAmount=amount(value, currency), runningBalance=amount(running, currency),
            referenceRaw=reference, descriptionRaw=description, counterpartyRaw=counterparty,
            evidence=[evidence],
        ))
    expected = Decimal(opening.value)
    row_errors = []
    for transaction in transactions:
        expected += signed(transaction)
        if expected != Decimal(transaction.runningBalance.value):
            row_errors.append(transaction.transactionId)
    difference = Decimal(closing.value) - expected
    reconciled = difference == 0 and not row_errors
    product = attributes["PRODUCT"].lower()
    ownership = attributes["OWNERSHIP"].lower()
    if ownership not in {"sole", "joint", "unknown"}:
        ownership = "unknown"
    facility_label = "OVERDRAFT_LIMIT" if product in {"current_account", "overdraft"} else (
        "CREDIT_LIMIT" if product == "credit_card" else None)
    facility_limit = amount(attributes[facility_label], currency) if facility_label in attributes else None
    return Segment(
        statementSegmentId=segment_id, bankId=attributes["BANK"].lower(), accountId=account_id,
        accountFingerprint=fingerprint,
        accountNumberMasked="*" * max(0, len(account) - 4) + account[-4:],
        productType=product, ledgerNature="liability" if product in {"credit_card", "loan"} else "asset",
        ownershipType=ownership, ownerName=attributes["OWNER"], currency=currency,
        periodStart=start, periodEnd=end, openingBalance=opening, closingBalance=closing,
        transactions=transactions, pages=[page_number], reportedFacilityLimit=facility_limit,
        openingEvidence=source_evidence("OPENING:"), closingEvidence=source_evidence("CLOSING:"),
        facilityEvidence=source_evidence(f"{facility_label}:") if facility_limit is not None else [],
        bankProfileVersion=profile("ai7-synthetic-v1")["formatVersion"],
        reconciliation={"status": "fully_reconciled" if reconciled else "unreconciled",
                        "difference": f"{difference:.{CURRENCY_SCALE[currency]}f}", "rowErrorIds": row_errors,
                        "formulaVersion": "reconciliation-v1.0.0"},
    )


def _fingerprint(transaction: Transaction):
    return (transaction.accountId, transaction.bookingDate, transaction.creditDebitIndicator,
            transaction.ledgerAmount.value, transaction.ledgerCurrency,
            transaction.descriptionRaw.casefold().strip(), transaction.referenceRaw.casefold().strip(),
            transaction.runningBalance.value)


def detect_circular_flows(transfers: list[dict]) -> list[dict]:
    """Return exact, bounded temporal cycles as flow signals, never fraud claims."""
    protected = ("savings", "credit card", "brokerage", "fixed deposit", "loan repayment")
    eligible = [item for item in transfers if not any(term in
                (item.get("descriptionRaw", "") + " " + item.get("purpose", "")).casefold() for term in protected)]
    by_currency = defaultdict(list)
    for item in eligible:
        by_currency[item["amount"]["currency"]].append(item)
    findings = []
    seen = set()
    for currency, edges in by_currency.items():
        graph = nx.DiGraph()
        for edge in edges:
            graph.add_edge(edge["fromAccountId"], edge["toAccountId"])
        for cycle in islice(nx.simple_cycles(graph, length_bound=4), 100):
            if len(cycle) < 2:
                continue
            options = [[edge for edge in edges if edge["fromAccountId"] == source and
                        edge["toAccountId"] == cycle[(index + 1) % len(cycle)]]
                       for index, source in enumerate(cycle)]
            for path in islice(product(*options), 1000):
                values = {Decimal(edge["amount"]["value"]) for edge in path}
                days = [date.fromisoformat(edge["bookingDate"]) for edge in path]
                ids = sorted({transaction_id for edge in path for transaction_id in edge["transactionIds"]})
                key = tuple(ids)
                if len(values) != 1 or (max(days) - min(days)).days > 7 or key in seen:
                    continue
                seen.add(key)
                findings.append({"accountIds": cycle, "transactionIds": ids, "amount": path[0]["amount"],
                                 "netNewMoney": amount("0", currency).model_dump(),
                                 "classification": "direct_round_trip" if len(cycle) == 2 else "multi_hop_cycle",
                                 "fraudConclusion": False, "returnLagDays": (max(days) - min(days)).days,
                                 "incomeTreatment": "excluded", "reasonCodes": ["FUNDS_RETURNED_TO_ORIGIN"],
                                 "method": "bounded-temporal-cycle-v2"})
        # Split and recombine is reported once for the conserved group.
        for origin in sorted({edge["fromAccountId"] for edge in edges}):
            outgoing = [edge for edge in edges if edge["fromAccountId"] == origin]
            if len(outgoing) < 2:
                continue
            for first, second in islice(((a, b) for index, a in enumerate(outgoing)
                                        for b in outgoing[index + 1:] if a["toAccountId"] != b["toAccountId"]), 100):
                returns = [edge for edge in edges if edge["toAccountId"] == origin and
                           edge["fromAccountId"] in {first["toAccountId"], second["toAccountId"]}]
                for return_first in returns:
                    for return_second in returns:
                        if return_first is return_second or return_first["fromAccountId"] == return_second["fromAccountId"]:
                            continue
                        group = (first, second, return_first, return_second)
                        days = [date.fromisoformat(edge["bookingDate"]) for edge in group]
                        if ((max(days) - min(days)).days > 7 or
                                sum(Decimal(edge["amount"]["value"]) for edge in group[:2]) !=
                                sum(Decimal(edge["amount"]["value"]) for edge in group[2:])):
                            continue
                        ids = sorted({id for edge in group for id in edge["transactionIds"]})
                        key = tuple(ids)
                        if key in seen:
                            continue
                        seen.add(key)
                        gross = sum(Decimal(edge["amount"]["value"]) for edge in group[:2])
                        findings.append({"accountIds": sorted({origin, first["toAccountId"], second["toAccountId"]}),
                                         "transactionIds": ids, "amount": amount(str(gross), currency).model_dump(),
                                         "netNewMoney": amount("0", currency).model_dump(),
                                         "classification": "split_recombine_cycle", "fraudConclusion": False,
                                         "returnLagDays": (max(days) - min(days)).days,
                                         "incomeTreatment": "excluded", "reasonCodes": ["FUNDS_RETURNED_TO_ORIGIN"],
                                         "method": "bounded-temporal-cycle-v2"})
    return findings[:100]


def analyze(data: bytes, analysis_id: str, declarations: dict | None = None,
            tenant_scope: str | None = None, layout_extractor: Extractor | None = None,
            untrusted_pages: set[int] | None = None) -> dict:
    document_id = identifier("doc", analysis_id)
    try:
        extracted = NativePdfExtractor().analyze(DocumentInput(documentId=document_id, data=data))
        pages = [page.text for page in extracted.pages]
        for number in untrusted_pages or set():
            if 1 <= number <= len(pages):
                pages[number - 1] = ""
    except ValueError as error:
        return {"analysisId": analysis_id, "status": "failed", "decisionEligible": False,
                "reasonCodes": [str(error)], "segments": [], "features": {}, "schemaVersion": "bsa-v1.0.0"}
    except Exception:
        return {"analysisId": analysis_id, "status": "failed", "decisionEligible": False,
                "reasonCodes": ["INVALID_PDF"], "segments": [], "features": {}, "schemaVersion": "bsa-v1.0.0"}
    segments = []
    unsupported_pages = []
    reasons = []
    extractor = "pypdf-native-v1"
    for number, text in enumerate(pages, 1):
        try:
            segment = parse_page(text, number, document_id, extracted.pages[number - 1].lineEvidence, tenant_scope)
        except Exception:
            segment = None
        if segment:
            segments.append(segment)
        else:
            unsupported_pages.append(number)
    still_unsupported = []
    review_pages = set()
    for run in _unsupported_runs(pages, unsupported_pages):
        subset = _extract_subset(data, run)
        parsed_segments = []
        uncovered = list(run)
        managed_reasons = []
        if layout_extractor is not None:
            from .layout_bridge import parse_layout_document
            try:
                layout = layout_extractor.analyze(DocumentInput(documentId=document_id, data=subset))
                parsed_segments, managed_reasons, local_uncovered = parse_layout_document(layout, tenant_scope)
                uncovered = [run[number - 1] for number in local_uncovered]
            except ValueError as error:
                managed_reasons = [str(error)]
            except Exception:
                managed_reasons = ["MANAGED_EXTRACTION_FAILED"]
            if parsed_segments:
                extractor = "mixed-local-extractors-v1" if segments else layout.extractorVersion
                for parsed_segment in parsed_segments:
                    segments.append(_restore_page_numbers(parsed_segment, run))
                still_unsupported.extend(uncovered)
                reasons.extend(managed_reasons)
                continue
        if all(not pages[number - 1].strip() for number in run):
            from .ocr_adapter import extract_ocr_tokens, parse_banque_misr_tokens
            tokens = None
            try:
                tokens = extract_ocr_tokens(subset)
                parsed, run_reasons = parse_banque_misr_tokens(tokens, document_id, tenant_scope)
            except ValueError as error:
                parsed, run_reasons = None, [str(error)]
            except Exception:
                parsed, run_reasons = None, ["OCR_FAILED"]
            if parsed:
                parsed_segments = [parsed]
                uncovered = []
                extractor = "mixed-local-extractors-v1" if segments else "rapidocr-onnx-v1"
            elif tokens is not None:
                from .generic_ocr import parse_scanned_generic
                try:
                    parsed_segments, run_reasons, local_uncovered = parse_scanned_generic(tokens, document_id, tenant_scope)
                    uncovered = [run[number - 1] for number in local_uncovered]
                    if parsed_segments:
                        extractor = "mixed-local-extractors-v1" if segments else "rapidocr-generic-table-v1"
                    elif run_reasons:
                        review_pages.update(uncovered)
                except Exception:
                    run_reasons = ["OCR_GENERIC_EXTRACTION_FAILED"]
                if not parsed_segments:
                    try:
                        arabic_tokens = extract_ocr_tokens(subset, language="arabic")
                        arabic_segments, arabic_reasons, arabic_uncovered = parse_scanned_generic(
                            arabic_tokens, document_id, tenant_scope)
                        if arabic_segments:
                            parsed_segments, run_reasons = arabic_segments, arabic_reasons
                            uncovered = [run[number - 1] for number in arabic_uncovered]
                            review_pages.difference_update(set(run) - set(uncovered))
                            extractor = "mixed-local-extractors-v1" if segments else "rapidocr-generic-arabic-v1"
                    except ValueError as error:
                        run_reasons = sorted(set([*run_reasons, str(error)]))
                    except Exception:
                        run_reasons = sorted(set([*run_reasons, "OCR_ARABIC_EXTRACTION_FAILED"]))
            if not parsed_segments:
                from .paddle_ocr import extract_paddle_tokens
                from .generic_ocr import parse_scanned_generic
                for language in ("english", "arabic"):
                    try:
                        paddle_tokens = extract_paddle_tokens(subset, language=language)
                        candidate_segments, candidate_reasons, candidate_uncovered = parse_scanned_generic(
                            paddle_tokens, document_id, tenant_scope, f"paddleocr-{language}-v1")
                        if candidate_segments:
                            parsed_segments, run_reasons = candidate_segments, candidate_reasons
                            uncovered = [run[number - 1] for number in candidate_uncovered]
                            review_pages.difference_update(set(run) - set(uncovered))
                            extractor = "mixed-local-extractors-v1" if segments else f"paddleocr-{language}-v1"
                            break
                        run_reasons = sorted(set([*run_reasons, *candidate_reasons]))
                    except ValueError as error:
                        run_reasons = sorted(set([*run_reasons, str(error)]))
                    except Exception:
                        run_reasons = sorted(set([*run_reasons, "PADDLE_OCR_FAILED"]))
        else:
            from .adcb_adapter import parse_adcb_pdf
            try:
                parsed, run_reasons = parse_adcb_pdf(subset, document_id, tenant_scope)
            except Exception:
                parsed, run_reasons = None, ["UNSUPPORTED_BANK_FORMAT"]
            if parsed:
                parsed_segments = [parsed]
                uncovered = []
                extractor = "mixed-local-extractors-v1" if segments else "pdfplumber-table-v1"
            else:
                from .generic_adapter import parse_generic_pdf
                try:
                    parsed_segments, run_reasons, local_uncovered = parse_generic_pdf(subset, document_id, tenant_scope)
                    uncovered = [run[number - 1] for number in local_uncovered]
                    if any(code in run_reasons for code in (
                        "LEDGER_NOT_RECONCILED", "AMBIGUOUS_COLUMN_MAPPING",
                        "GENERIC_STATEMENT_FIELDS_INCOMPLETE", "AMBIGUOUS_DATE_FORMAT",
                        "CONFLICTING_DATE_FORMAT", "TRANSACTION_OUTSIDE_STATED_PERIOD")):
                        review_pages.update(uncovered)
                except Exception:
                    parsed_segments, run_reasons = [], ["GENERIC_EXTRACTION_FAILED"]
                if parsed_segments:
                    extractor = "mixed-local-extractors-v1" if segments else "generic-table-inference-v1"
        for parsed_segment in parsed_segments:
            segments.append(_restore_page_numbers(parsed_segment, run))
        still_unsupported.extend(uncovered)
        reasons.extend(run_reasons)
        reasons.extend(managed_reasons)
    unsupported_pages = still_unsupported
    if set(unsupported_pages) - review_pages:
        reasons.append("UNSUPPORTED_BANK_FORMAT")
    if not segments and not review_pages:
        reasons.append("NO_STATEMENT_DETECTED")
    if any(segment.reconciliation["status"] != "fully_reconciled" for segment in segments):
        reasons.append("LEDGER_NOT_RECONCILED")
    if any(segment.ownershipType == "unknown" for segment in segments):
        reasons.append("OWNER_ATTRIBUTION_AMBIGUOUS")
    if any(segment.ownershipType == "joint" and any(row.creditDebitIndicator == "CREDIT" for row in segment.transactions)
           for segment in segments):
        reasons.append("JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED")
    seen = {}
    retained = []
    duplicate_groups = []
    for segment in segments:
        for transaction in segment.transactions:
            key = _fingerprint(transaction)
            if key in seen:
                duplicate_groups.append({"retainedTransactionId": seen[key], "duplicateTransactionId": transaction.transactionId})
            else:
                seen[key] = transaction.transactionId
                retained.append((segment, transaction))
    counterparties_by_name = {}
    for _, transaction in retained:
        normalized = normalize_name(transaction.counterpartyRaw)
        transaction.descriptionNormalized = " ".join(transaction.descriptionRaw.casefold().split())
        if not normalized:
            continue
        counterparty_id = identifier("cp", document_id, normalized)
        transaction.counterpartyId = counterparty_id
        record = counterparties_by_name.setdefault(normalized, {
            "counterpartyId": counterparty_id, "nameNormalized": normalized, "rawVariants": set(),
            "transactionIds": [], "confidence": 0.65, "verified": False,
            "resolution": "normalized_text_candidate", "methodVersion": "counterparty-normalization-v1"})
        record["rawVariants"].add(transaction.counterpartyRaw)
        record["transactionIds"].append(transaction.transactionId)
    counterparties = [{**record, "rawVariants": sorted(record["rawVariants"])}
                      for _, record in sorted(counterparties_by_name.items())]
    if duplicate_groups:
        reasons.append("OVERLAPPING_PERIODS_DEDUPLICATED")
    owner_by_account = {segment.accountId: segment.ownerName.casefold().strip() for segment in segments}
    ownership_by_account = {segment.accountId: segment.ownershipType for segment in segments}
    references = defaultdict(list)
    for segment, transaction in retained:
        if transaction.referenceRaw:
            references[(transaction.referenceRaw.casefold(), segment.currency, transaction.ledgerAmount.value)].append((segment, transaction))
    transfer_ids = set()
    transfers = []
    for matches in references.values():
        for debit_segment, debit in matches:
            if debit.creditDebitIndicator != "DEBIT" or debit.transactionId in transfer_ids:
                continue
            for credit_segment, credit in matches:
                if credit.creditDebitIndicator != "CREDIT" or credit.transactionId in transfer_ids or debit.accountId == credit.accountId:
                    continue
                if abs((date.fromisoformat(debit.bookingDate) - date.fromisoformat(credit.bookingDate)).days) > 2:
                    continue
                same_owner = owner_by_account[debit.accountId] == owner_by_account[credit.accountId]
                confirmed = same_owner and ownership_by_account[debit.accountId] == ownership_by_account[credit.accountId] == "sole"
                if not confirmed:
                    continue
                transfer_ids.update([debit.transactionId, credit.transactionId])
                transfers.append({"fromAccountId": debit.accountId, "toAccountId": credit.accountId,
                                  "amount": debit.ledgerAmount.model_dump(), "transactionIds": [debit.transactionId, credit.transactionId],
                                  "bookingDate": debit.bookingDate, "descriptionRaw": debit.descriptionRaw,
                                  "relationship": "probable_self_transfer", "method": "paired-reference-amount-owner-v1"})
                break
    circular_flows = detect_circular_flows(transfers)
    incomes = defaultdict(list)
    excluded = []
    unclassified_outflows = []
    expenses = defaultdict(Decimal)
    for segment, transaction in retained:
        if transaction.transactionId in transfer_ids:
            excluded.append({"transactionId": transaction.transactionId, "reasonCode": "SELF_TRANSFER"})
            continue
        if segment.ledgerNature != "asset":
            excluded.append({"transactionId": transaction.transactionId, "reasonCode": "LIABILITY_LEDGER"})
            continue
        if segment.reconciliation["status"] != "fully_reconciled" or segment.ownershipType != "sole":
            reason = "LEDGER_NOT_RECONCILED" if segment.reconciliation["status"] != "fully_reconciled" else (
                "JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED" if segment.ownershipType == "joint" else "OWNER_ATTRIBUTION_AMBIGUOUS")
            target = unclassified_outflows if transaction.creditDebitIndicator == "DEBIT" else excluded
            target.append({"transactionId": transaction.transactionId, "reasonCode": reason})
            continue
        if transaction.creditDebitIndicator == "DEBIT":
            expenses[segment.currency] += Decimal(transaction.ledgerAmount.value)
            continue
        description = transaction.descriptionRaw.casefold()
        if any(term in description for term in ("loan", "refund", "reversal", "advance")):
            excluded.append({"transactionId": transaction.transactionId, "reasonCode": "NON_INCOME_CREDIT"})
        elif segment.ownershipType != "sole":
            excluded.append({"transactionId": transaction.transactionId, "reasonCode": "JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED"})
        elif "salary" in description or "payroll" in description:
            payer = normalize_name(transaction.counterpartyRaw)
            incomes[(segment.currency, payer)].append(transaction)
        else:
            excluded.append({"transactionId": transaction.transactionId, "reasonCode": "UNVERIFIED_CREDIT"})
    salary_streams = []
    for (currency, payer), transactions in incomes.items():
        months = {transaction.bookingDate[:7] for transaction in transactions}
        stable = len(months) >= 3
        values = [Decimal(transaction.ledgerAmount.value) for transaction in transactions]
        salary_streams.append({"observedPayer": payer, "currency": currency, "months": sorted(months),
                               "candidateMonthlyAmount": amount(str(median(values)), currency).model_dump(),
                               "stable": stable, "confidence": 0.85 if stable else 0.45,
                               "includedTransactionIds": [transaction.transactionId for transaction in transactions],
                               "formulaVersion": "income-v1.0.0"})
        if not stable:
            reasons.append("INSUFFICIENT_STABLE_INCOME_HISTORY")
    status = "completed" if segments and not any(reason in reasons for reason in
        ("UNSUPPORTED_BANK_FORMAT", "NO_STATEMENT_DETECTED", "LEDGER_NOT_RECONCILED",
         "OWNER_ATTRIBUTION_AMBIGUOUS", "JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED")) else "partial"
    if not segments:
        status = "partial"
    coverage_matrix = []
    by_ledger = defaultdict(list)
    for segment in segments:
        by_ledger[(segment.accountId, segment.currency)].append(segment)
    for (account_id, currency), ledger_segments in by_ledger.items():
        periods = sorted([(item.periodStart, item.periodEnd, item.statementSegmentId) for item in ledger_segments])
        coverage_matrix.append({"accountId": account_id, "currency": currency,
                                "periods": [{"start": start, "end": end, "segmentId": segment_id} for start, end, segment_id in periods],
                                "overlapDetected": any(periods[index][0] <= periods[index - 1][1] for index in range(1, len(periods)))})
    accounts, balances, facilities = canonical_accounts(segments)
    daily, daily_reasons = daily_balances(segments)
    reasons.extend(daily_reasons)
    if daily_reasons:
        status = "partial"
    observed = [(segment, transaction) for segment, transaction in retained]
    employers = employer_timeline(salary_streams, observed)
    liquidity_features = liquidity(daily, accounts)
    duplicate_pages = document_page_duplicates(pages)
    irregularities = financial_signals(observed, liquidity_features, employers)
    irregularities.extend(duplicate_pages)
    if duplicate_pages:
        reasons.append("DUPLICATE_STATEMENT_PAGE")
        status = "partial"
    obligation_features = obligations(observed, transfer_ids)
    cash_flow = monthly_cash_flow(observed, transfer_ids)
    relationships = resolve_accounts(accounts, transfers)
    reconciled_count = sum(segment.reconciliation["status"] == "fully_reconciled" for segment in segments)
    return {"analysisId": analysis_id, "status": status, "decisionEligible": False, "demoOnly": True,
            "analysis": {"analysisId": analysis_id, "status": status, "schemaVersion": "bsa-v1.0.0"},
            "subjects": {"declared": declarations or {}, "verified": False},
            "reasonCodes": sorted(set(reasons)), "schemaVersion": "bsa-v1.0.0",
            "coverage": {"pageCount": len(pages), "supportedPages": [page for segment in segments for page in segment.pages],
                         "unsupportedPages": unsupported_pages, "transactionCount": len(retained)},
            "segments": [segment.model_dump() for segment in segments],
            "documents": {"documentId": document_id, "pageCount": len(pages),
                          "unsupportedPages": unsupported_pages, "segmentIds": [item.statementSegmentId for item in segments],
                          "duplicatePageGroups": duplicate_pages},
            "accounts": accounts,
            "balances": balances, "facilities": facilities, "duplicates": duplicate_groups,
            "coverageMatrix": coverage_matrix, "transfers": transfers, "accountRelationships": relationships,
            "circularFlows": circular_flows, "dailyBalances": daily,
            "liquidity": liquidity_features, "observedObligations": obligation_features,
            "monthlyCashFlow": cash_flow,
            "observedEmployers": employers, "employers": employers,
            "obligations": obligation_features,
            "cashFlow": cash_flow,
            "income": {"salaryStreams": salary_streams,
                       "monthlyGrossAndCandidateExternalCredits": cash_flow,
                       "excludedCredits": excluded,
                       "formulaVersion": "income-v1.0.0"},
            "circularity": {"selfTransfers": transfers, "cycles": circular_flows},
            "counterparties": counterparties, "irregularities": irregularities,
            "affordabilityFeatures": affordability_candidates(cash_flow, salary_streams, obligation_features),
            "findings": [{"reasonCode": code, "classification": "review_signal"} for code in sorted(set(reasons))],
            "artifacts": [],
            "quality": {"reconciledSegments": reconciled_count, "totalSegments": len(segments),
                        "unsupportedPageCount": len(unsupported_pages),
                        "ownerAttributionComplete": all(segment.ownershipType == "sole" for segment in segments),
                        "decisionEligible": False},
            "limitations": ["Local demonstration only; no lender decision or verified income claim.",
                            "Candidate external credits require payer and purpose verification."],
            "features": {"salaryStreams": salary_streams, "excludedCredits": excluded,
                         "unclassifiedOutflows": unclassified_outflows,
                         "observedExpensesByCurrency": [amount(str(value), currency).model_dump() for currency, value in expenses.items()]},
            "versions": {"extractor": extractor, "reconciliation": "reconciliation-v1.0.0",
                         "income": "income-v1.0.0", "analytics": "analytics-v1.0.0",
                         "bankProfiles": {segment.bankId: segment.bankProfileVersion for segment in segments},
                         "irregularities": "irregularities-v1.0.0",
                         "counterparty": "counterparty-normalization-v1",
                         "relationships": "account-relationship-v1.0.0",
                         "transfer": "paired-reference-amount-owner-v1", "circularity": "bounded-temporal-cycle-v2"}}
