"""Native-text adapter for ADCB's seven-column Account Statement layout."""

import hashlib
import io
import re
from datetime import datetime
from decimal import Decimal

import pdfplumber

from .contracts import Evidence, Money, Segment, Transaction
from .registry import profile
from .identifiers import account_fingerprint


ACCOUNT = re.compile(r"^(\d{10,20})\s+(AED|USD|EUR|GBP)$")
PERIOD = re.compile(r"^From (\d{2}/\d{2}/\d{4}) to (\d{2}/\d{2}/\d{4})$", re.I)
AMOUNT = re.compile(r"^(-?\d[\d,]*(?:\.\d{1,2})?)\s+(AED|USD|EUR|GBP)$")
TABLE_HEADER = profile("adcb-native-7col-2026")["tableHeader"]


def _id(prefix: str, *parts: str) -> str:
    return f"{prefix}_{hashlib.sha256(chr(31).join(parts).encode()).hexdigest()[:18]}"


def _money(value: str, currency: str) -> Money:
    number = Decimal(value.strip().replace(",", ""))
    if not number.is_finite() or -number.as_tuple().exponent > 2:
        raise ValueError("INVALID_AMOUNT")
    return Money(value=f"{number:.2f}", currency=currency, scale=2)


def _date(value: str) -> str:
    return datetime.strptime(value, "%d/%m/%Y").date().isoformat()


def _metadata(table: list[list[str | None]]) -> dict[str, str]:
    return {str(row[0] or "").strip().removesuffix(":"): str(row[1] or "").strip()
            for row in table if len(row) == 2}


def parse_adcb_pdf(data: bytes, document_id: str, tenant_scope: str | None = None) -> tuple[Segment | None, list[str]]:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        if not pdf.pages:
            return None, ["NO_STATEMENT_DETECTED"]
        first_tables = pdf.pages[0].find_tables()
        metadata_table = next((table for table in first_tables
                               if len(table.rows) >= 6 and len(table.rows[0].cells) == 2), None)
        metadata = _metadata(metadata_table.extract()) if metadata_table else {}
        account_match = ACCOUNT.fullmatch(metadata.get("Account Number", ""))
        period_match = PERIOD.fullmatch(metadata.get("Statement Period", ""))
        opening_match = AMOUNT.fullmatch(metadata.get("Opening Balance", ""))
        closing_match = AMOUNT.fullmatch(metadata.get("Closing Balance", ""))
        if not (account_match and period_match and opening_match and closing_match):
            return None, ["UNSUPPORTED_BANK_FORMAT"]
        account, currency = account_match.groups()
        if opening_match.group(2) != currency or closing_match.group(2) != currency:
            return None, ["CURRENCY_MISMATCH"]
        period_start, period_end = map(_date, period_match.groups())
        if period_start > period_end:
            return None, ["INVALID_STATEMENT_PERIOD"]
        owner = metadata.get("Account Name(s)", "").replace("\n", " ").strip()
        if not owner:
            return None, ["OWNER_ATTRIBUTION_AMBIGUOUS"]
        opening = _money(opening_match.group(1), currency)
        closing = _money(closing_match.group(1), currency)
        fingerprint = account_fingerprint(tenant_scope or document_id, "adcb", account)
        account_id = f"acc_{fingerprint.removeprefix('sha256:')[:18]}"
        segment_id = _id("seg", document_id, "adcb", account, period_start, period_end)
        def metadata_evidence(label: str) -> list[Evidence]:
            if not metadata_table:
                return []
            for index, row in enumerate(metadata_table.extract()):
                if str(row[0] or "").strip().removesuffix(":") != label:
                    continue
                box = metadata_table.rows[index].bbox
                page = pdf.pages[0]
                polygon = [[round(box[0] / page.width, 4), round(box[1] / page.height, 4)],
                           [round(box[2] / page.width, 4), round(box[1] / page.height, 4)],
                           [round(box[2] / page.width, 4), round(box[3] / page.height, 4)],
                           [round(box[0] / page.width, 4), round(box[3] / page.height, 4)]]
                return [Evidence(documentId=document_id, statementSegmentId=segment_id, page=1,
                                 rawText=" | ".join(str(cell or "") for cell in row),
                                 extractionMethod="pdfplumber-table-v1", extractorVersion="pdfplumber-table-v1",
                                 boundingPolygon=polygon,
                                 boundingBox=[polygon[0][0], polygon[0][1], polygon[2][0], polygon[2][1]])]
            return []
        opening_evidence = metadata_evidence("Opening Balance")
        closing_evidence = metadata_evidence("Closing Balance")
        transactions = []
        unreadable_rows = []
        for page_number, page in enumerate(pdf.pages, 1):
            tables = page.find_tables()
            transaction_tables = [table for table in tables if len(table.rows[0].cells) == 7
                                  and [str(cell or "").replace("\n", " ").strip() for cell in table.extract()[0]] == TABLE_HEADER]
            if len(transaction_tables) != 1:
                return None, ["UNSUPPORTED_BANK_FORMAT"]
            table = transaction_tables[0]
            for row_number, cells in enumerate(table.extract()[1:], 1):
                if len(cells) != 7:
                    unreadable_rows.append({"page": page_number, "row": row_number})
                    continue
                fields = [str(cell or "").strip() for cell in cells]
                try:
                    booking_date = _date(fields[0].splitlines()[0])
                    debit, credit, balance = (_money(fields[index], currency) for index in (4, 5, 6))
                    debit_value, credit_value = Decimal(debit.value), Decimal(credit.value)
                    if not period_start <= booking_date <= period_end or (debit_value != 0) == (credit_value != 0):
                        raise ValueError("AMBIGUOUS_ROW")
                    signed_value = credit_value - debit_value
                except (ValueError, IndexError):
                    unreadable_rows.append({"page": page_number, "row": row_number})
                    continue
                row_bbox = table.rows[row_number].bbox
                evidence = Evidence(documentId=document_id, statementSegmentId=segment_id, page=page_number,
                                    rawText=" | ".join(fields), extractionMethod="pdfplumber-table-v1",
                                    extractionConfidence=1.0,
                                    boundingBox=[round(row_bbox[0] / page.width, 4), round(row_bbox[1] / page.height, 4),
                                                 round(row_bbox[2] / page.width, 4), round(row_bbox[3] / page.height, 4)])
                transactions.append(Transaction(
                    transactionId=_id("txn", segment_id, str(page_number), str(row_number)), accountId=account_id,
                    ledgerCurrency=currency, bookingDate=booking_date,
                    creditDebitIndicator="CREDIT" if signed_value > 0 else "DEBIT",
                    ledgerAmount=_money(str(abs(signed_value)), currency), runningBalance=balance,
                    referenceRaw=fields[3].replace("\n", " "), descriptionRaw=fields[2].replace("\n", " "),
                    counterpartyRaw="", evidence=[evidence],
                ))
    if not transactions:
        return None, ["NO_TRANSACTION_ROWS"]
    expected = Decimal(opening.value)
    row_errors = []
    for transaction in transactions:
        value = Decimal(transaction.ledgerAmount.value)
        expected += value if transaction.creditDebitIndicator == "CREDIT" else -value
        if expected != Decimal(transaction.runningBalance.value):
            row_errors.append(transaction.transactionId)
    difference = Decimal(closing.value) - expected
    reconciled = not unreadable_rows and not row_errors and difference == 0
    reasons = ["OWNER_ATTRIBUTION_AMBIGUOUS"]
    if unreadable_rows:
        reasons.append("TABLE_ROWS_INCOMPLETE")
    if not reconciled:
        reasons.append("LEDGER_NOT_RECONCILED")
    segment = Segment(
        statementSegmentId=segment_id, bankId="adcb", accountId=account_id,
        accountFingerprint=fingerprint,
        accountNumberMasked="*" * (len(account) - 4) + account[-4:], productType="current_account",
        ledgerNature="asset", ownershipType="unknown", ownerName=owner, currency=currency,
        periodStart=period_start, periodEnd=period_end, openingBalance=opening, closingBalance=closing,
        transactions=transactions, pages=list(range(1, len(pdf.pages) + 1)),
        openingEvidence=opening_evidence, closingEvidence=closing_evidence,
        bankProfileVersion=profile("adcb-native-7col-2026")["formatVersion"],
        reconciliation={"status": "fully_reconciled" if reconciled else "unreconciled", "difference": f"{difference:.2f}",
                        "rowErrorIds": row_errors, "unreadableRows": unreadable_rows,
                        "formulaVersion": "reconciliation-v1.0.0"},
    )
    return segment, reasons
