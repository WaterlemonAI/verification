from pathlib import Path
from io import BytesIO

import pymupdf
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

from bsa.engine import analyze
from bsa.generic_adapter import _columns, parse_generic_pages


def statement(path: Path, bank: str, account: str, *, reversed_columns=False,
              swapped_values=False, closing="115.00", grid=True):
    doc = SimpleDocTemplate(str(path), pagesize=letter, leftMargin=36, rightMargin=36)
    metadata = Table([
        ["Account Number", account], ["Statement Period", "From 13/01/2026 to 31/01/2026"],
        ["Currency", "AED"], ["Account Holder", "FICTIONAL CUSTOMER"],
        ["Opening Balance", "100.00 AED"], ["Closing Balance", f"{closing} AED"],
    ], colWidths=[170, 230])
    if reversed_columns:
        rows = [["Balance", "Description", "Deposit", "Date", "Withdrawal"],
                ["90.00", "Shop", "", "13/01/2026", "10.00"],
                ["110.00", "Transfer", "20.00", "14/01/2026", ""],
                ["115.00", "Refund", "5.00", "15/01/2026", ""]]
        widths = [80, 140, 85, 95, 85]
    else:
        rows = [["Transaction Date", "Details", "Debit", "Credit", "Running Balance"],
                ["13/01/2026", "Shop", "10.00", "", "90.00"],
                ["14/01/2026", "Transfer", "", "20.00", "110.00"],
                ["15/01/2026", "Refund", "", "5.00", "115.00"]]
        widths = [100, 145, 80, 80, 80]
        if swapped_values:
            for row in rows[1:]:
                row[2], row[3] = row[3], row[2]
    transactions = Table(rows, colWidths=widths)
    for table in (metadata, transactions):
        table.setStyle(TableStyle(([ ("GRID", (0, 0), (-1, -1), 0.5, colors.black) ] if grid else []) + [
                                   ("FONTSIZE", (0, 0), (-1, -1), 9),
                                   ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    from reportlab.platypus import Paragraph
    from reportlab.lib.styles import getSampleStyleSheet
    doc.build([Paragraph(bank, getSampleStyleSheet()["Title"]), metadata, Spacer(1, 24), transactions])


def test_unknown_banks_and_column_orders_reconcile_without_profiles(tmp_path):
    paths = [tmp_path / "a.pdf", tmp_path / "b.pdf"]
    statement(paths[0], "Fictional Crescent Bank", "7788990011")
    statement(paths[1], "Fictional Palm Finance", "1122334455", reversed_columns=True)
    writer = PdfWriter()
    for path in paths:
        for page in PdfReader(path).pages:
            writer.add_page(page)
    combined = tmp_path / "combined.pdf"
    with combined.open("wb") as output:
        writer.write(output)
    result = analyze(combined.read_bytes(), "bsa_generic_two", tenant_scope="local-test")
    assert len(result["segments"]) == 2
    assert result["coverage"]["unsupportedPages"] == []
    assert result["coverage"]["transactionCount"] == 6
    assert result["quality"]["reconciledSegments"] == 2
    assert {segment["bankProfileVersion"] for segment in result["segments"]} == {"generic-table-inference-v1"}
    assert {segment["pages"][0] for segment in result["segments"]} == {1, 2}
    assert all(segment["transactions"][0]["evidence"][0]["boundingBox"] for segment in result["segments"])
    assert result["status"] == "partial"  # name alone does not establish ownership
    assert result["decisionEligible"] is False


def test_generic_mismatch_fails_closed(tmp_path):
    path = tmp_path / "wrong.pdf"
    statement(path, "Fictional Crescent Bank", "7788990011", closing="116.00")
    result = analyze(path.read_bytes(), "bsa_generic_wrong")
    assert result["segments"] == []
    assert "LEDGER_NOT_RECONCILED" in result["reasonCodes"]
    assert "NO_STATEMENT_DETECTED" not in result["reasonCodes"]
    assert "UNSUPPORTED_BANK_FORMAT" not in result["reasonCodes"]
    assert result["decisionEligible"] is False


def test_balance_invariant_selects_unique_swapped_mapping(tmp_path):
    path = tmp_path / "columns.pdf"
    statement(path, "Fictional Dune Bank", "5544332211", swapped_values=True)
    result = analyze(path.read_bytes(), "bsa_generic_swapped")
    assert result["segments"][0]["reconciliation"]["debitCreditSwapped"] is True
    assert "COLUMN_MAPPING_INFERRED_FROM_BALANCES" in result["reasonCodes"]
    assert result["segments"][0]["transactions"][0]["creditDebitIndicator"] == "DEBIT"


def test_borderless_native_table_uses_text_geometry(tmp_path):
    path = tmp_path / "borderless.pdf"
    statement(path, "Fictional Dune Bank", "5544332211", grid=False)
    result = analyze(path.read_bytes(), "bsa_generic_borderless")
    assert result["coverage"]["transactionCount"] == 3
    assert result["quality"]["reconciledSegments"] == 1


def test_scanned_unknown_bank_uses_generic_ocr_and_reconciliation(tmp_path):
    native = tmp_path / "native.pdf"
    scanned = tmp_path / "scanned.pdf"
    statement(native, "Fictional Dune Bank", "5544332211", grid=False)
    source = pymupdf.open(native)
    pixmap = source[0].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    output = canvas.Canvas(str(scanned), pagesize=letter)
    output.drawImage(ImageReader(BytesIO(pixmap.tobytes("png"))), 0, 0,
                     width=letter[0], height=letter[1])
    output.showPage()
    output.save()
    result = analyze(scanned.read_bytes(), "bsa_generic_scan")
    assert result["coverage"]["transactionCount"] == 3
    assert result["quality"]["reconciledSegments"] == 1
    assert result["versions"]["extractor"] == "rapidocr-generic-table-v1"
    assert result["segments"][0]["transactions"][0]["evidence"][0]["extractionMethod"] == "rapidocr-generic-table-v1"


def test_multilingual_concept_aliases_do_not_require_bank_mapping():
    assert _columns(["التاريخ", "البيان", "مدين", "دائن", "الرصيد"]) == {
        "date": 0, "description": 1, "debit": 2, "credit": 3, "balance": 4,
    }


def test_arabic_digits_metadata_and_rtl_column_order_reconcile():
    from types import SimpleNamespace

    class TableView:
        def __init__(self, rows):
            self.values = rows
            self.rows = [SimpleNamespace(cells=row, bbox=(10, 30 + index * 10, 200, 39 + index * 10))
                         for index, row in enumerate(rows)]

        def extract(self):
            return self.values

    class PageView:
        width = 250
        height = 300

        def extract_text(self):
            return ("مصرف افتراضي\nرقم الحساب: ١٢٣٤٥٦٧٨٩٠\n"
                    "فترة كشف الحساب: من ١٣/٠١/٢٠٢٦ إلى ٣١/٠١/٢٠٢٦\n"
                    "العملة: AED\nاسم العميل: عميل تجريبي\n"
                    "الرصيد الافتتاحي: ١٠٠٫٠٠ AED\nالرصيد الختامي: ١١٥٫٠٠ AED")

        def find_tables(self, **_kwargs):
            return [TableView([
                ["الرصيد", "دائن", "مدين", "البيان", "التاريخ"],
                ["٩٠٫٠٠", "", "١٠٫٠٠", "شراء", "١٣/٠١/٢٠٢٦"],
                ["١١٠٫٠٠", "٢٠٫٠٠", "", "تحويل", "١٤/٠١/٢٠٢٦"],
                ["١١٥٫٠٠", "٥٫٠٠", "", "استرداد", "١٥/٠١/٢٠٢٦"],
            ])]

        def search(self, *_args, **_kwargs):
            return [{"x0": 10, "top": 10, "x1": 100, "bottom": 20}]

    segments, reasons, unsupported = parse_generic_pages([PageView()], "bsa_arabic_demo")
    assert unsupported == []
    assert len(segments) == 1
    assert len(segments[0].transactions) == 3
    assert segments[0].periodStart == "2026-01-13"
    assert segments[0].periodEnd == "2026-01-31"
    assert segments[0].reconciliation["status"] == "fully_reconciled"
    assert "OWNER_ATTRIBUTION_AMBIGUOUS" in reasons
