"""Readable, authenticated XLSX audit export using only Python's standard library.

All statement text is emitted as inline strings, never as user-controlled Excel
formulas. Only the fixed residual-cash-flow formula is written as a formula.
"""

import io
import re
import zipfile
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from xml.sax.saxutils import escape


def _safe(value: object) -> str:
    text = str(value if value is not None else "")[:32000]
    return "".join(char for char in text if ord(char) >= 32 or char in "\t\n\r")


def _xml(value: object) -> str:
    return escape(_safe(value), {'"': '&quot;'})


def _column(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _number(value: object) -> float | None:
    try:
        parsed = Decimal(str(value))
        return float(parsed) if parsed.is_finite() else None
    except (InvalidOperation, TypeError, ValueError):
        return None


def _cell(reference: str, value: object, style: int = 0, formula: str | None = None) -> str:
    if formula is not None:
        numeric = _number(value)
        return f'<c r="{reference}" s="{style}"><f>{_xml(formula)}</f><v>{numeric if numeric is not None else 0}</v></c>'
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        numeric = _number(value)
        if numeric is not None:
            return f'<c r="{reference}" s="{style}"><v>{numeric}</v></c>'
    return f'<c r="{reference}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{_xml(value)}</t></is></c>'


def _sheet(rows: list[list], widths: list[int], *, filter_row: int | None = None,
           merges: list[str] | None = None) -> bytes:
    content = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
               '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
               '<sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
               '<sheetFormatPr defaultRowHeight="18"/>',
               '<cols>', *(f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
                            for index, width in enumerate(widths, 1)), '</cols><sheetData>']
    for row_number, row in enumerate(rows, 1):
        height = 34 if row_number == 1 else (28 if row_number in {2, 3} else
                 38 if any(isinstance(entry, tuple) and len(entry) > 1 and entry[1] == 11 for entry in row)
                 else 20)
        content.append(f'<row r="{row_number}" ht="{height}" customHeight="1">')
        for column_number, entry in enumerate(row, 1):
            if entry is None:
                continue
            value, style, *rest = entry if isinstance(entry, tuple) else (entry, 0)
            content.append(_cell(f'{_column(column_number)}{row_number}', value, style,
                                 rest[0] if rest else None))
        content.append('</row>')
    content.append('</sheetData>')
    if merges:
        content.append(f'<mergeCells count="{len(merges)}">')
        content.extend(f'<mergeCell ref="{_xml(item)}"/>' for item in merges)
        content.append('</mergeCells>')
    if filter_row and len(rows) > filter_row:
        content.append(f'<autoFilter ref="A{filter_row}:{_column(len(widths))}{len(rows)}"/>')
    content.append('<pageMargins left="0.35" right="0.35" top="0.55" bottom="0.55" header="0.2" footer="0.2"/>')
    content.append('</worksheet>')
    return ''.join(content).encode()


STYLES = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Aptos"/><color rgb="FF23382F"/></font><font><b/><sz val="18"/><name val="Aptos Display"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="10"/><name val="Aptos"/><color rgb="FF0A2B1C"/></font><font><b/><sz val="10"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font><font><sz val="9"/><name val="Aptos"/><color rgb="FF52685D"/></font></fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF10251C"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC7F779"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F7F2"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE8C6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFADBD8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="4" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="6" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="5" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'''
STYLES = STYLES.replace(b'<cellXfs count="11">', b'<cellXfs count="12">').replace(
    b'</cellXfs>',
    b'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs>',
)


def _header(title: str, subtitle: str, width: int) -> tuple[list[list], list[str]]:
    return (
        [[(title, 1)], [(subtitle, 2)], [("Decision support only · Statement observations require human verification", 2)], []],
        [f'A1:{_column(width)}1', f'A2:{_column(width)}2', f'A3:{_column(width)}3'],
    )


def _money(item: dict | None) -> float | None:
    return _number((item or {}).get("value"))


def build_xlsx(result: dict) -> bytes:
    assessment = result.get("creditAssessment", {})
    highlights = assessment.get("riskHighlights", [])
    models = assessment.get("models", [])
    analysis_id = result.get("analysisId", "")
    tabs = []
    account_labels = {item["accountId"]: f"{item.get('bankId', '')} · {item.get('accountNumberMasked', '')}"
                      for item in result.get("accounts", [])}
    masked_accounts = {item["accountId"]: item.get("accountNumberMasked", "")
                       for item in result.get("accounts", [])}

    overview, merges = _header("BANK STATEMENT · REVIEW", f"Analysis {analysis_id}   |   {result.get('status', '').upper()}", 4)
    overview += [[(name, 4) for name in ("Pages", "Transactions", "Reconciled ledgers", "Eligibility")],
                 [result.get("coverage", {}).get("pageCount", 0), result.get("coverage", {}).get("transactionCount", 0),
                  f"{result.get('quality', {}).get('reconciledSegments', 0)} / {len(result.get('segments', []))}", "Not determined"],
                 [], [("PRIORITY REVIEW", 3)],
                 [(name, 4) for name in ("Priority", "Pattern", "What was observed", "Recommended check")]]
    for item in highlights[:12]:
        priority = item.get("reviewPriority", "info")
        overview.append([(priority.upper(), 7 if priority == "high" else 8 if priority == "medium" else 5),
                         item.get("title"), (item.get("explanation"), 11), (item.get("suggestedReview"), 11)])
    overview += [[], [("SELECTED MODEL OBSERVATIONS", 3)],
                 [(name, 4) for name in ("Model · account", "Observed value", "Status", "Limit")]]
    for model in models:
        observations = model.get("observations") or [{}]
        for item in observations:
            measure = item.get("value") or {}
            value = measure.get("value")
            if measure.get("unit") == "ratio" and value is not None:
                value = f"{Decimal(value) * 100:.1f}%"
            elif value is not None:
                value = f"{value} {measure.get('unit', '')}".strip()
            account = masked_accounts.get(item.get("accountId"))
            overview.append([(model.get("name") if not account else f"{model.get('name')} · {account}", 11),
                             value or "Not calculable", item.get("status", model.get("status")),
                             (model.get("limitation"), 11)])
    tabs.append(("Overview", overview, [48, 28, 42, 82], None, merges))

    cash, merges = _header("MONTHLY CASH FLOW", "Per owned, reconciled account · No currency conversion", 8)
    cash.append([(name, 4) for name in ("Account", "Month", "Currency", "Candidate credits", "Non-transfer debits", "Residual", "Transfers excluded", "Source transaction IDs")])
    for row in result.get("monthlyCashFlow", []):
        number = len(cash) + 1
        credits = _money(row.get("candidateExternalCredits")) or 0
        debits = (_money(row.get("grossDebits")) or 0) - (_money(row.get("selfTransferDebits")) or 0)
        transfers = _money(row.get("selfTransferCredits")) or 0
        cash.append([account_labels.get(row.get("accountId"), row.get("accountId")), row.get("month"), row.get("currency"), (credits, 6), (debits, 6),
                     (credits - debits, 6, f"D{number}-E{number}"), (transfers, 6),
                     ", ".join(row.get("sourceTransactionIds", []))])
    tabs.append(("Cash Flow", cash, [29, 14, 12, 21, 24, 20, 22, 85], 5, merges))

    ledgers, merges = _header("RECONCILED LEDGERS", "Balances are reported per segment and currency", 10)
    ledgers.append([(name, 4) for name in ("Bank", "Masked account", "Product", "Owner type", "Currency", "Period start", "Period end", "Opening", "Closing", "Reconciliation")])
    for segment in result.get("segments", []):
        ledgers.append([segment.get("bankId"), segment.get("accountNumberMasked"), segment.get("productType"),
                        segment.get("ownershipType"), segment.get("currency"), segment.get("periodStart"),
                        segment.get("periodEnd"), (_money(segment.get("openingBalance")), 6),
                        (_money(segment.get("closingBalance")), 6),
                        segment.get("reconciliation", {}).get("status")])
    tabs.append(("Ledgers", ledgers, [23, 21, 21, 17, 13, 17, 17, 18, 18, 26], 5, merges))

    review, merges = _header("REVIEW SIGNALS", "Priority means review order, not a credit or fraud classification", 8)
    review.append([(name, 4) for name in ("Priority", "Code", "Pattern", "What was observed", "Recommended check", "Account", "Currency", "Evidence IDs")])
    for item in highlights:
        priority = item.get("reviewPriority", "info")
        review.append([(priority.upper(), 7 if priority == "high" else 8 if priority == "medium" else 5),
                       item.get("code"), item.get("title"), (item.get("explanation"), 11),
                       (item.get("suggestedReview"), 11), account_labels.get(item.get("accountId"), item.get("accountId")), item.get("currency"),
                       ", ".join([*item.get("sourceSegmentIds", []), *item.get("sourceTransactionIds", [])])])
    tabs.append(("Review Signals", review, [15, 36, 31, 70, 65, 29, 12, 90], 5, merges))

    transactions, merges = _header("TRANSACTIONS", "Source rows are preserved; amounts and balances remain in ledger currency", 11)
    transactions.append([(name, 4) for name in ("Date", "Bank", "Account", "Currency", "Direction", "Amount", "Running balance", "Description", "Reference", "Source page", "Transaction ID")])
    for segment in result.get("segments", []):
        for row in segment.get("transactions", []):
            transactions.append([row.get("bookingDate"), segment.get("bankId"), segment.get("accountNumberMasked"),
                                 row.get("ledgerCurrency"), row.get("creditDebitIndicator"),
                                 (_money(row.get("ledgerAmount")), 6), (_money(row.get("runningBalance")), 6),
                                 row.get("descriptionRaw"), row.get("referenceRaw"),
                                 row.get("evidence", [{}])[0].get("page") if row.get("evidence") else None,
                                 row.get("transactionId")])
    tabs.append(("Transactions", transactions, [16, 22, 22, 12, 15, 18, 20, 62, 27, 15, 35], 5, merges))

    methods, merges = _header("METHODS & LIMITS", "Formulas are transparent; lender policy and external verification are separate", 5)
    methods.append([(name, 4) for name in ("Model", "Formula", "Observed status", "Limitation", "Source")])
    for model in models:
        methods.append([model.get("name"), (model.get("formula"), 11), model.get("status"),
                        (model.get("limitation"), 11), model.get("source")])
    for limitation in assessment.get("limitations", []):
        methods.append(["General limitation", "", "", limitation, ""])
    tabs.append(("Methodology", methods, [34, 85, 22, 95, 90], 5, merges))

    workbook = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>']
    relationships = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                     '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
             '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
             '<Default Extension="xml" ContentType="application/xml"/>',
             '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
             '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for index, (name, rows, widths, filter_row, merged) in enumerate(tabs, 1):
            workbook.append(f'<sheet name="{_xml(name)}" sheetId="{index}" r:id="rId{index}"/>')
            relationships.append(f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>')
            types.append(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
            archive.writestr(f"xl/worksheets/sheet{index}.xml", _sheet(rows, widths, filter_row=filter_row, merges=merged))
        workbook.append('</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
        relationships.append(f'<Relationship Id="rId{len(tabs) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
        relationships.append('</Relationships>')
        types.append('</Types>')
        archive.writestr('[Content_Types].xml', ''.join(types))
        archive.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr('xl/workbook.xml', ''.join(workbook))
        archive.writestr('xl/_rels/workbook.xml.rels', ''.join(relationships))
        archive.writestr('xl/styles.xml', STYLES)
    return output.getvalue()
