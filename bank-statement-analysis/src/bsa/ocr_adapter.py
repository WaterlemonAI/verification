"""Bounded OCR adapter for Banque Misr's scanned historical-statement layout.

Only the table geometry and labels below are supported. OCR values are never
silently repaired; every retained row must pass exact running-balance checks.
"""

import hashlib
import io
import os
import re
from pathlib import Path
from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache

from .contracts import Evidence, Money, Segment, Transaction
from .registry import profile
from .identifiers import account_fingerprint
from .ocr_models import verified_models


DATE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
HEADER_DATE = re.compile(r"^\d{2}-\d{2}-\d{4}$")
MONEY = re.compile(r"^-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$")


def _id(prefix: str, *parts: str) -> str:
    return f"{prefix}_{hashlib.sha256(chr(31).join(parts).encode()).hexdigest()[:18]}"


def _money(value: str, currency: str) -> Money:
    number = Decimal(value.replace(",", ""))
    if not number.is_finite() or -number.as_tuple().exponent > 2:
        raise ValueError("INVALID_OCR_AMOUNT")
    return Money(value=f"{number:.2f}", currency=currency, scale=2)


def _iso(value: str, fmt: str) -> str:
    return datetime.strptime(value, fmt).date().isoformat()


def _text(item: dict) -> str:
    return item["text"].strip()


def _near_label(items: list[dict], label: str, *, max_delta: float = 0.018) -> list[dict]:
    labels = [item for item in items if label in _text(item).casefold()]
    if not labels:
        return []
    marker = min(labels, key=lambda item: item["y"])
    return sorted((item for item in items if item["x"] > marker["x"] + 0.08
                   and abs(item["y"] - marker["y"]) < max_delta), key=lambda item: item["x"])


def parse_banque_misr_tokens(pages: list[list[dict]], document_id: str,
                            tenant_scope: str | None = None) -> tuple[Segment | None, list[str]]:
    if not pages:
        return None, ["OCR_NO_PAGES"]
    first = pages[0]
    combined_header = " ".join(_text(item).casefold() for item in first if item["y"] < 0.24)
    if any(token not in combined_header for token in profile("banque-misr-scan-v1")["headerTokens"]):
        return None, ["OCR_UNSUPPORTED_LAYOUT"]
    account_candidates = [item for item in _near_label(first, "account number")
                          if re.fullmatch(r"\d{10,20}", _text(item))]
    currency_candidates = [item for item in _near_label(first, "account currency")
                           if _text(item).upper() in {"AED", "USD", "EUR", "GBP"}]
    owner_candidates = [item for item in _near_label(first, "customer name") if len(_text(item)) >= 3]
    opening_candidates = [item for item in _near_label(first, "previous balance", max_delta=0.015)
                          if MONEY.fullmatch(_text(item))]
    period_dates = sorted((item for item in first if HEADER_DATE.fullmatch(_text(item)) and item["y"] < 0.22),
                          key=lambda item: item["x"])
    if not (account_candidates and currency_candidates and owner_candidates and opening_candidates and len(period_dates) >= 2):
        return None, ["OCR_HEADER_INCOMPLETE"]
    account = _text(account_candidates[0])
    currency = _text(currency_candidates[0]).upper()
    owner = _text(owner_candidates[0])
    opening = _money(_text(opening_candidates[0]), currency)
    period_start = _iso(_text(period_dates[0]), "%d-%m-%Y")
    period_end = _iso(_text(period_dates[-1]), "%d-%m-%Y")
    if period_start > period_end:
        return None, ["OCR_INVALID_PERIOD"]
    fingerprint = account_fingerprint(tenant_scope or document_id, "banque-misr", account)
    account_id = f"acc_{fingerprint.removeprefix('sha256:')[:18]}"
    segment_id = _id("seg", document_id, "banque-misr", account, period_start, period_end)
    transactions = []
    missing_rows = []
    last_printed_balance = None
    last_balance_token = None
    last_balance_page = None
    for page_number, items in enumerate(pages, 1):
        page_header = " ".join(_text(item).casefold() for item in items if item["y"] < 0.24)
        if "historical statement" not in page_header:
            return None, ["OCR_UNSUPPORTED_LAYOUT"]
        dates = sorted((item for item in items if DATE.fullmatch(_text(item)) and 0.10 <= item["x"] <= 0.23
                        and item["y"] > 0.20), key=lambda item: item["y"])
        for index, date_item in enumerate(dates):
            top = (dates[index - 1]["y"] + date_item["y"]) / 2 if index else date_item["y"] - 0.018
            bottom = (date_item["y"] + dates[index + 1]["y"]) / 2 if index + 1 < len(dates) else date_item["y"] + 0.022
            row = [item for item in items if top <= item["y"] < bottom and item["y"] > 0.20]
            money_items = [item for item in row if MONEY.fullmatch(_text(item))]
            debit = [item for item in money_items if 0.65 <= item["x"] < 0.79]
            credit = [item for item in money_items if 0.79 <= item["x"] < 0.88]
            balance = [item for item in money_items if item["x"] >= 0.88]
            if len(balance) == 1:
                last_printed_balance = _money(_text(balance[0]), currency)
                last_balance_token = balance[0]
                last_balance_page = page_number
            if len(balance) != 1 or len(debit) + len(credit) != 1:
                missing_rows.append({"page": page_number, "row": index + 1})
                continue
            booking_date = _iso(_text(date_item), "%d/%m/%Y")
            if not period_start <= booking_date <= period_end:
                missing_rows.append({"page": page_number, "row": index + 1})
                continue
            entry = credit[0] if credit else debit[0]
            direction = "CREDIT" if credit else "DEBIT"
            description = " ".join(_text(item) for item in sorted(row, key=lambda item: (item["y"], item["x"]))
                                   if 0.34 <= item["x"] < 0.65)
            reference = " ".join(_text(item) for item in sorted(row, key=lambda item: item["x"])
                                 if 0.27 <= item["x"] < 0.34)
            evidence_items = sorted(row, key=lambda item: (item["y"], item["x"]))
            evidence = Evidence(documentId=document_id, statementSegmentId=segment_id, page=page_number,
                                rawText=" | ".join(_text(item) for item in evidence_items),
                                extractionMethod="rapidocr-onnx-v1",
                                extractionConfidence=min(float(item["confidence"]) for item in (date_item, entry, balance[0])),
                                boundingBox=[round(min(item["x0"] for item in row), 4),
                                             round(min(item["y0"] for item in row), 4),
                                             round(max(item["x1"] for item in row), 4),
                                             round(max(item["y1"] for item in row), 4)])
            transactions.append(Transaction(
                transactionId=_id("txn", segment_id, str(page_number), str(index)), accountId=account_id,
                ledgerCurrency=currency, bookingDate=booking_date, creditDebitIndicator=direction,
                ledgerAmount=_money(_text(entry), currency), runningBalance=_money(_text(balance[0]), currency),
                referenceRaw=reference, descriptionRaw=description, counterpartyRaw="", evidence=[evidence],
            ))
    if not transactions or last_printed_balance is None:
        return None, ["OCR_NO_TRANSACTION_ROWS"]
    expected = Decimal(opening.value)
    row_errors = []
    for transaction in transactions:
        value = Decimal(transaction.ledgerAmount.value)
        expected += value if transaction.creditDebitIndicator == "CREDIT" else -value
        if expected != Decimal(transaction.runningBalance.value):
            row_errors.append(transaction.transactionId)
    difference = Decimal(last_printed_balance.value) - expected
    reconciled = not missing_rows and not row_errors and difference == 0
    reasons = []
    if missing_rows:
        reasons.append("OCR_ROWS_INCOMPLETE")
    if not reconciled:
        reasons.append("LEDGER_NOT_RECONCILED")
    reasons.append("OWNER_ATTRIBUTION_AMBIGUOUS")
    def header_evidence(item: dict, page_number: int) -> list[Evidence]:
        polygon = [[item["x0"], item["y0"]], [item["x1"], item["y0"]],
                   [item["x1"], item["y1"]], [item["x0"], item["y1"]]]
        return [Evidence(documentId=document_id, statementSegmentId=segment_id, page=page_number,
                         rawText=_text(item), extractionMethod="rapidocr-onnx-v1",
                         extractionConfidence=float(item["confidence"]), extractorVersion="rapidocr-onnx-v1",
                         boundingPolygon=polygon,
                         boundingBox=[item["x0"], item["y0"], item["x1"], item["y1"]])]
    segment = Segment(
        statementSegmentId=segment_id, bankId="banque-misr", accountId=account_id,
        accountFingerprint=fingerprint,
        accountNumberMasked="*" * (len(account) - 4) + account[-4:], productType="current_account",
        ledgerNature="asset", ownershipType="unknown", ownerName=owner, currency=currency,
        periodStart=period_start, periodEnd=period_end, openingBalance=opening, closingBalance=last_printed_balance,
        transactions=transactions, pages=list(range(1, len(pages) + 1)),
        openingEvidence=header_evidence(opening_candidates[0], 1),
        closingEvidence=header_evidence(last_balance_token, last_balance_page),
        bankProfileVersion=profile("banque-misr-scan-v1")["formatVersion"],
        reconciliation={"status": "fully_reconciled" if reconciled else "unreconciled",
                        "difference": f"{difference:.2f}", "rowErrorIds": row_errors,
                        "unreadableRows": missing_rows, "formulaVersion": "reconciliation-v1.0.0"},
    )
    return segment, reasons


@lru_cache(maxsize=1)
def _ocr_engine():
    from rapidocr import RapidOCR
    root = _model_root()
    if not verified_models(root, ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx",
                                  "ch_ppocr_mobile_v2.0_cls_mobile.onnx")):
        raise ValueError("OCR_MODEL_UNAVAILABLE")
    return RapidOCR(params={"Global.model_root_dir": str(root)})


def _model_root() -> Path:
    configured = os.getenv("BSA_OCR_MODEL_ROOT")
    if configured:
        return Path(configured)
    import rapidocr
    return Path(rapidocr.__file__).parent / "models"


@lru_cache(maxsize=1)
def _arabic_ocr_engine():
    from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR
    root = _model_root()
    if not verified_models(root, ("PP-OCRv6_det_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                                  "arabic_PP-OCRv5_rec_mobile.onnx")):
        raise ValueError("OCR_ARABIC_MODEL_UNAVAILABLE")
    return RapidOCR(params={"Global.model_root_dir": str(root), "Rec.lang_type": LangRec.ARABIC,
                            "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.MOBILE})


def extract_ocr_tokens(data: bytes, language: str = "latin") -> list[list[dict]]:
    try:
        import pymupdf
    except ImportError:
        raise ValueError("OCR_UNAVAILABLE")
    document = pymupdf.open(stream=data, filetype="pdf")
    if len(document) > 10:
        raise ValueError("OCR_PAGE_LIMIT_EXCEEDED")
    try:
        engine = _arabic_ocr_engine() if language == "arabic" else _ocr_engine()
    except ImportError:
        raise ValueError("OCR_UNAVAILABLE")
    pages = []
    for page in document:
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1.7, 1.7), alpha=False)
        output = engine(pixmap.tobytes("png"))
        items = []
        for box, text, score in zip(output.boxes, output.txts, output.scores):
            xs = [float(point[0]) / pixmap.width for point in box]
            ys = [float(point[1]) / pixmap.height for point in box]
            items.append({"text": str(text), "x": sum(xs) / 4, "y": sum(ys) / 4,
                          "x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys),
                          "confidence": float(score)})
        pages.append(items)
    return pages


def parse_scanned_banque_misr(data: bytes, document_id: str,
                              tenant_scope: str | None = None) -> tuple[Segment | None, list[str]]:
    try:
        pages = extract_ocr_tokens(data)
    except ValueError as error:
        return None, [str(error)]
    return parse_banque_misr_tokens(pages, document_id, tenant_scope)
