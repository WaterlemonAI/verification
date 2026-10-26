"""Bank-neutral native PDF table discovery with accounting-based mapping selection.

This adapter recognizes concepts, not institutions. It deliberately leaves
ownership unknown and never promotes a ledger that fails printed-balance checks.
"""

import hashlib
import io
import re
import unicodedata
from datetime import datetime
from decimal import Decimal, InvalidOperation

import pdfplumber

from .contracts import Evidence, Money, Segment, Transaction
from .identifiers import account_fingerprint


VERSION = "generic-table-inference-v1"
SCALES = {"AED": 2, "USD": 2, "EUR": 2, "GBP": 2, "KWD": 3, "BHD": 3, "OMR": 3, "JPY": 0}
DATE_TOKEN = r"\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}"
ACCOUNT = re.compile(r"(?:account\s*(?:number|no\.?|#)|iban|رقم\s*الحساب)\s*[:：]?\s*([A-Z]{2}\d{12,32}|\d{6,24})", re.I)
PERIOD = re.compile(rf"(?:statement\s*)?period\s*[:：]?\s*(?:from\s*)?({DATE_TOKEN})\s*(?:to|until|[-–])\s*({DATE_TOKEN})", re.I)
ARABIC_PERIOD = re.compile(rf"(?:فترة\s*(?:كشف\s*)?الحساب|فترة\s*الكشف|من)\s*[:：]?\s*(?:من\s*)?({DATE_TOKEN})\s*(?:إلى|الى|حتى|[-–])\s*({DATE_TOKEN})")
CURRENCY = re.compile(r"\b(AED|USD|EUR|GBP|KWD|BHD|OMR|JPY)\b", re.I)
MONEY = re.compile(r"\(?\s*-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,3})?\s*\)?")

ALIASES = {
    "date": ("posting date", "transaction date", "txn date", "booking date", "date", "التاريخ", "تاريخ المعاملة"),
    "description": ("description", "narrative", "particulars", "details", "transaction details", "البيان", "الوصف"),
    "debit": ("debit", "withdrawal", "withdrawals", "paid out", "مدين", "سحب"),
    "credit": ("credit", "deposit", "deposits", "paid in", "دائن", "إيداع"),
    "balance": ("running balance", "closing balance", "balance", "الرصيد", "رصيد"),
    "amount": ("transaction amount", "amount", "المبلغ", "مبلغ"),
    "reference": ("reference", "ref", "cheque no", "رقم المرجع"),
}


def _id(prefix: str, *parts: str) -> str:
    return f"{prefix}_{hashlib.sha256(chr(31).join(parts).encode()).hexdigest()[:18]}"


def _norm(value: str) -> str:
    value = _ascii_digits(value)
    value = "".join(character for character in unicodedata.normalize("NFKC", value).casefold()
                    if unicodedata.category(character) != "Mn" and character != "ـ")
    return " ".join(re.sub(r"[^\w\u0600-\u06ff]+", " ", value).split())


def _ascii_digits(value: str) -> str:
    """Normalize Arabic-Indic digits and separators without changing source evidence."""
    digits = "".join(str(unicodedata.decimal(character)) if character.isdecimal() else character
                     for character in value)
    return digits.translate(str.maketrans({"٫": ".", "٬": ",", "،": ","}))


def _concept(label: str) -> str | None:
    normalized = _norm(label)
    if not normalized:
        return None
    for concept, aliases in ALIASES.items():
        if any(_norm(alias) == normalized for alias in aliases):
            return concept
    for concept, aliases in ALIASES.items():
        if any(_norm(alias) in normalized for alias in aliases if len(_norm(alias)) >= 5):
            return concept
    return None


def _columns(header: list[str]) -> dict[str, int] | None:
    columns = {}
    for index, label in enumerate(header):
        concept = _concept(label)
        if concept and concept not in columns:
            columns[concept] = index
    if {"date", "description", "balance"} <= columns.keys() and (
        {"debit", "credit"} <= columns.keys() or "amount" in columns
    ):
        return columns
    return None


def _decimal(raw: str, currency: str) -> Decimal:
    cleaned = CURRENCY.sub("", _ascii_digits(raw)).strip().replace(",", "").replace(" ", "")
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    cleaned = cleaned.strip("()")
    if cleaned in {"", "-", "—", "–"}:
        return Decimal(0)
    try:
        value = Decimal(cleaned)
    except InvalidOperation as error:
        raise ValueError("INVALID_AMOUNT") from error
    if negative:
        value = -value
    scale = SCALES[currency]
    if not value.is_finite() or -value.as_tuple().exponent > scale:
        raise ValueError("INVALID_AMOUNT_PRECISION")
    return value


def _money(value: Decimal, currency: str) -> Money:
    scale = SCALES[currency]
    return Money(value=f"{value:.{scale}f}", currency=currency, scale=scale)


def _date(raw: str, day_first: bool | None = None) -> str:
    token = re.search(DATE_TOKEN, _ascii_digits(raw.strip()))
    if not token:
        raise ValueError("INVALID_DATE")
    text = token.group()
    if len(re.split(r"[-/.]", text)[0]) == 4:
        return datetime.strptime(text.replace("/", "-").replace(".", "-"), "%Y-%m-%d").date().isoformat()
    parts = re.split(r"[-/.]", text)
    if len(parts) != 3 or len(parts[2]) != 4:
        raise ValueError("AMBIGUOUS_DATE_FORMAT")
    first, second = int(parts[0]), int(parts[1])
    if first <= 12 and second <= 12 and first != second and day_first is None:
        raise ValueError("AMBIGUOUS_DATE_FORMAT")
    fmt = "%d/%m/%Y" if first > 12 or first == second or day_first else "%m/%d/%Y"
    return datetime.strptime("/".join(parts), fmt).date().isoformat()


def _date_order(values: list[str]) -> bool | None:
    order = set()
    for value in values:
        token = re.search(DATE_TOKEN, _ascii_digits(value))
        if not token:
            continue
        parts = re.split(r"[-/.]", token.group())
        if len(parts[0]) == 4:
            continue
        first, second = int(parts[0]), int(parts[1])
        if first > 12:
            order.add(True)
        if second > 12:
            order.add(False)
    if len(order) > 1:
        raise ValueError("CONFLICTING_DATE_FORMAT")
    return next(iter(order)) if order else None


def _evidence(document_id: str, segment_id: str, page_number: int, raw: str,
              bbox: tuple[float, float, float, float] | None, width: float, height: float,
              method: str = VERSION) -> Evidence:
    if bbox is None:
        return Evidence(documentId=document_id, statementSegmentId=segment_id, page=page_number,
                        rawText=raw, extractionMethod=method, extractorVersion=method)
    x0, y0, x1, y1 = bbox
    box = [round(x0 / width, 4), round(y0 / height, 4), round(x1 / width, 4), round(y1 / height, 4)]
    return Evidence(documentId=document_id, statementSegmentId=segment_id, page=page_number,
                    rawText=raw, extractionMethod=method, extractorVersion=method,
                    boundingBox=box, boundingPolygon=[[box[0], box[1]], [box[2], box[1]],
                                                   [box[2], box[3]], [box[0], box[3]]])


def _field(lines: list[str], labels: tuple[str, ...]) -> str | None:
    for line in lines:
        normalized = _norm(line)
        for label in labels:
            if normalized.startswith(_norm(label)):
                return line[len(label):].strip(" :：\t")
    return None


def _metadata(page) -> dict:
    lines = (page.extract_text() or "").splitlines()
    for table in page.find_tables():
        if table.rows and len(table.rows[0].cells) == 2:
            for row in table.extract():
                if len(row) == 2 and row[0] and row[1]:
                    lines.append(f"{str(row[0]).replace(chr(10), ' ')}: {str(row[1]).replace(chr(10), ' ')}")
    joined = _ascii_digits("\n".join(lines))
    account = ACCOUNT.search(joined)
    period = PERIOD.search(joined) or ARABIC_PERIOD.search(joined)
    currency = CURRENCY.search(joined)
    opening = _field(lines, ("opening balance", "starting balance", "previous balance", "الرصيد الافتتاحي"))
    closing = _field(lines, ("closing balance", "ending balance", "الرصيد الختامي"))
    owner = _field(lines, ("account holder", "account name", "customer name", "اسم صاحب الحساب", "اسم العميل"))
    def locate(value: str | None):
        if not value:
            return None
        matches = page.search(re.escape(value.strip()), regex=True)
        if not matches:
            return None
        match = matches[0]
        return (match["x0"], match["top"], match["x1"], match["bottom"])
    return {"account": account.group(1) if account else None,
            "period": period.groups() if period else None,
            "currency": currency.group(1).upper() if currency else ("AED" if "درهم إماراتي" in joined or "درهم اماراتي" in joined else None),
            "opening": opening, "closing": closing, "owner": owner,
            "openingBBox": locate(opening), "closingBBox": locate(closing),
            "bankHint": lines[0].strip() if lines else ""}


def _balance(raw: str, currency: str) -> Decimal:
    match = MONEY.search(raw)
    if not match:
        raise ValueError("MISSING_PRINTED_BALANCE")
    return _decimal(match.group(), currency)


def _tables(page, page_number: int) -> list[dict]:
    for settings in (None, {"vertical_strategy": "text", "horizontal_strategy": "text",
                            "min_words_vertical": 3, "min_words_horizontal": 1}):
        found = []
        tables = page.find_tables(table_settings=settings) if settings else page.find_tables()
        for table in tables:
            cells = table.extract()
            if not cells:
                continue
            columns = _columns([str(value or "").replace("\n", " ") for value in cells[0]])
            if not columns:
                continue
            for index, row in enumerate(cells[1:], 1):
                if index >= len(table.rows):
                    break
                found.append({"fields": [str(value or "").replace("\n", " ").strip() for value in row],
                              "columns": columns, "bbox": table.rows[index].bbox,
                              "page": page_number, "width": page.width, "height": page.height})
        if found:
            return found
    return _text_rows(page, page_number)


def _text_rows(page, page_number: int) -> list[dict]:
    """Read aligned native text when the PDF has no drawn table borders."""
    words = sorted(page.extract_words(), key=lambda word: (word["top"], word["x0"]))
    lines = []
    for word in words:
        if not lines or abs(word["top"] - lines[-1][0]["top"]) > getattr(page, "line_tolerance", 3):
            lines.append([])
        lines[-1].append(word)
    found = []
    active = None
    for line in lines:
        line.sort(key=lambda word: word["x0"])
        tokens = [_norm(word["text"]) for word in line]
        matches = {}
        occupied = set()
        for concept in ("date", "description", "debit", "credit", "balance", "amount", "reference"):
            for alias in sorted(ALIASES[concept], key=lambda item: -len(_norm(item).split())):
                parts = _norm(alias).split()
                for start in range(len(tokens) - len(parts) + 1):
                    span = set(range(start, start + len(parts)))
                    if tokens[start:start + len(parts)] == parts and not span & occupied:
                        matches[concept] = (start, start + len(parts) - 1)
                        occupied.update(span)
                        break
                if concept in matches:
                    break
        if {"date", "description", "balance"} <= matches.keys() and (
            {"debit", "credit"} <= matches.keys() or "amount" in matches
        ):
            ordered = sorted(((key, span, (line[span[0]]["x0"] + line[span[1]]["x1"]) / 2)
                              for key, span in matches.items()), key=lambda item: item[2])
            bounds = [(ordered[index][2] + ordered[index + 1][2]) / 2 for index in range(len(ordered) - 1)]
            active = {"ordered": ordered, "bounds": bounds,
                      "columns": {key: index for index, (key, _, _) in enumerate(ordered)}}
            continue
        if not active:
            continue
        fields = [[] for _ in active["ordered"]]
        for word in line:
            center = (word["x0"] + word["x1"]) / 2
            index = sum(center > bound for bound in active["bounds"])
            fields[index].append(word["text"])
        joined = [" ".join(field) for field in fields]
        if not re.search(DATE_TOKEN, _ascii_digits(joined[active["columns"]["date"]])):
            continue
        bbox = (min(word["x0"] for word in line), min(word["top"] for word in line),
                max(word["x1"] for word in line), max(word["bottom"] for word in line))
        found.append({"fields": joined, "columns": active["columns"], "bbox": bbox,
                      "page": page_number, "width": page.width, "height": page.height})
    return found


def _build(group: list[dict], document_id: str, tenant_scope: str | None,
           method: str = VERSION) -> tuple[Segment | None, list[str]]:
    first = next((item["meta"] for item in group if item["meta"]["account"]), {})
    account = first.get("account")
    currency = first.get("currency") or next((item["meta"]["currency"] for item in group if item["meta"]["currency"]), None)
    opening_info = next((item for item in group if item["meta"]["opening"]), None)
    closing_info = next((item for item in reversed(group) if item["meta"]["closing"]), None)
    opening_raw = opening_info["meta"]["opening"] if opening_info else None
    closing_raw = closing_info["meta"]["closing"] if closing_info else None
    rows = [row for item in group for row in item["rows"]]
    if not account or not currency or not opening_raw or not closing_raw or not rows:
        return None, ["GENERIC_STATEMENT_FIELDS_INCOMPLETE"]
    bank_hint = _norm(first.get("bankHint", ""))
    bank_id = re.sub(r"[^a-z0-9]+", "-", bank_hint).strip("-")[:48] or "unidentified-bank"
    fingerprint = account_fingerprint(tenant_scope or document_id, bank_id, account)
    account_id = f"acc_{fingerprint.removeprefix('sha256:')[:18]}"
    segment_id = _id("seg", document_id, account, str(group[0]["page"]), str(group[-1]["page"]))
    try:
        opening = _balance(opening_raw, currency)
        closing = _balance(closing_raw, currency)
        date_values = [row["fields"][row["columns"]["date"]] for row in rows]
        if first.get("period"):
            date_values.extend(first["period"])
        day_first = _date_order(date_values)
    except ValueError as error:
        return None, [str(error)]
    candidates = []
    for swapped in (False, True):
        if swapped and not all({"debit", "credit"} <= row["columns"].keys() for row in rows):
            continue
        transactions = []
        running = opening
        unreadable = []
        for index, row in enumerate(rows):
            fields, cols = row["fields"], row["columns"]
            try:
                booking_date = _date(fields[cols["date"]], day_first)
                printed = _decimal(fields[cols["balance"]], currency)
                if {"debit", "credit"} <= cols.keys():
                    debit = _decimal(fields[cols["credit" if swapped else "debit"]], currency)
                    credit = _decimal(fields[cols["debit" if swapped else "credit"]], currency)
                    if bool(debit) == bool(credit):
                        raise ValueError("AMBIGUOUS_ROW_DIRECTION")
                    delta = credit - debit
                else:
                    magnitude = abs(_decimal(fields[cols["amount"]], currency))
                    delta = printed - running
                    if not magnitude or abs(delta) != magnitude:
                        raise ValueError("AMBIGUOUS_ROW_DIRECTION")
                if not delta:
                    raise ValueError("ZERO_TRANSACTION")
                raw = " | ".join(fields)
                evidence = _evidence(document_id, segment_id, row["page"], raw, row["bbox"], row["width"], row["height"], method)
                transactions.append(Transaction(
                    transactionId=_id("txn", segment_id, str(index)), accountId=account_id,
                    ledgerCurrency=currency, bookingDate=booking_date,
                    creditDebitIndicator="CREDIT" if delta > 0 else "DEBIT",
                    ledgerAmount=_money(abs(delta), currency), runningBalance=_money(printed, currency),
                    referenceRaw=fields[cols["reference"]] if "reference" in cols else "",
                    descriptionRaw=fields[cols["description"]], counterpartyRaw="", evidence=[evidence]))
                if running + delta != printed:
                    unreadable.append(index)
                running += delta
            except (ValueError, IndexError, KeyError):
                unreadable.append(index)
        if not unreadable and transactions and running == closing:
            candidates.append((swapped, transactions))
    if len(candidates) != 1:
        return None, ["AMBIGUOUS_COLUMN_MAPPING" if len(candidates) > 1 else "LEDGER_NOT_RECONCILED"]
    swapped, transactions = candidates[0]
    period = first.get("period")
    try:
        start, end = (_date(item, day_first) for item in period) if period else (min(row.bookingDate for row in transactions),
                                                                       max(row.bookingDate for row in transactions))
    except ValueError as error:
        return None, [str(error)]
    if start > end or any(not start <= row.bookingDate <= end for row in transactions):
        return None, ["TRANSACTION_OUTSIDE_STATED_PERIOD"]
    reasons = ["OWNER_ATTRIBUTION_AMBIGUOUS"]
    if not period:
        reasons.append("STATED_PERIOD_MISSING")
    if swapped:
        reasons.append("COLUMN_MAPPING_INFERRED_FROM_BALANCES")
    opening_evidence = [_evidence(document_id, segment_id, opening_info["page"], opening_raw,
                                  opening_info["meta"]["openingBBox"], opening_info["width"], opening_info["height"], method)]
    closing_evidence = [_evidence(document_id, segment_id, closing_info["page"], closing_raw,
                                  closing_info["meta"]["closingBBox"], closing_info["width"], closing_info["height"], method)]
    if not opening_evidence[0].boundingBox or not closing_evidence[0].boundingBox:
        reasons.append("SOURCE_BALANCE_COORDINATES_UNAVAILABLE")
    segment = Segment(statementSegmentId=segment_id, bankId=bank_id, accountId=account_id,
                      accountFingerprint=fingerprint,
                      accountNumberMasked="*" * max(0, len(account) - 4) + account[-4:],
                      productType="unknown_deposit", ledgerNature="asset", ownershipType="unknown",
                      ownerName=first.get("owner") or "UNKNOWN", currency=currency,
                      periodStart=start, periodEnd=end, openingBalance=_money(opening, currency),
                      closingBalance=_money(closing, currency), transactions=transactions,
                      pages=[item["page"] for item in group], openingEvidence=opening_evidence,
                      closingEvidence=closing_evidence, bankProfileVersion=VERSION,
                      reconciliation={"status": "fully_reconciled", "difference": _money(Decimal(0), currency).value,
                                      "rowErrorIds": [], "formulaVersion": "reconciliation-v1.0.0",
                                      "mappingVersion": VERSION, "debitCreditSwapped": swapped})
    return segment, reasons


def parse_generic_pages(source_pages: list, document_id: str, tenant_scope: str | None = None,
                        method: str = VERSION) -> tuple[list[Segment], list[str], list[int]]:
    """Return recognized segments, reason codes, and local page numbers not claimed."""
    pages = [{"page": number, "meta": _metadata(page), "rows": _tables(page, number),
              "width": page.width, "height": page.height}
             for number, page in enumerate(source_pages, 1)]
    groups = []
    current = []
    signature = None
    uncovered = []
    for item in pages:
        meta = item["meta"]
        if not item["rows"]:
            uncovered.append(item["page"])
            continue
        candidate = (meta["account"], meta["period"])
        if current and meta["account"] and signature and candidate != signature:
            groups.append(current)
            current = []
        current.append(item)
        signature = candidate if meta["account"] else signature
    if current:
        groups.append(current)
    segments = []
    reasons = []
    for group in groups:
        segment, group_reasons = _build(group, document_id, tenant_scope, method)
        reasons.extend(group_reasons)
        if segment:
            segments.append(segment)
        else:
            uncovered.extend(item["page"] for item in group)
    return segments, sorted(set(reasons)), sorted(set(uncovered))


def parse_generic_pdf(data: bytes, document_id: str,
                      tenant_scope: str | None = None) -> tuple[list[Segment], list[str], list[int]]:
    with pdfplumber.open(io.BytesIO(data)) as document:
        return parse_generic_pages(document.pages, document_id, tenant_scope)
