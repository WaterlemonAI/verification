from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Spacer, Table, TableStyle
from pypdf import PdfReader, PdfWriter

from bsa.engine import analyze


def make_statement(path: Path, closing="115.00", account="12345678901234"):
    document = SimpleDocTemplate(str(path), pagesize=letter, leftMargin=36, rightMargin=36)
    metadata = Table([
        ["Account Number:", f"{account} AED"],
        ["Statement Period:", "From 01/01/2026 to 31/01/2026"],
        ["Account Name(s):", "EXAMPLE CUSTOMER"],
        ["Account Status:", "ACTIVE"],
        ["Opening Balance:", "100.00 AED"],
        ["Closing Balance:", f"{closing} AED"],
    ], colWidths=[250, 250], rowHeights=20)
    rows = [
        ["Posting Date", "Value Date", "Description", "Ref/Cheque No", "Debit Amount", "Credit Amount", "Balance"],
        ["02/01/2026", "02/01/2026", "Purchase", "R1", "10.00", "0.00", "90.00"],
        ["03/01/2026", "03/01/2026", "Deposit", "R2", "0.00", "20.00", "110.00"],
        ["04/01/2026", "04/01/2026", "Purchase reversal", "R3", "-5.00", "0.00", "115.00"],
    ]
    transactions = Table(rows, colWidths=[73, 73, 120, 74, 55, 55, 50], rowHeights=24)
    for table in (metadata, transactions):
        table.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
    document.build([metadata, Spacer(1, 24), transactions])


def test_adcb_native_table_and_negative_debit_reversal(tmp_path):
    path = tmp_path / "adcb-layout.pdf"
    make_statement(path)
    result = analyze(path.read_bytes(), "bsa_adcb_synthetic")
    assert result["status"] == "partial"  # statement ownership is unverified
    assert result["decisionEligible"] is False
    assert result["coverage"]["transactionCount"] == 3
    segment = result["segments"][0]
    assert segment["reconciliation"]["status"] == "fully_reconciled"
    assert segment["closingBalance"]["value"] == "115.00"
    assert segment["transactions"][2]["creditDebitIndicator"] == "CREDIT"
    assert segment["transactions"][2]["ledgerAmount"]["value"] == "5.00"
    assert segment["transactions"][0]["evidence"][0]["boundingBox"]
    assert result["features"]["observedExpensesByCurrency"] == []
    assert result["features"]["salaryStreams"] == []


def test_adcb_header_closing_mismatch_never_reconciles(tmp_path):
    path = tmp_path / "adcb-mismatch.pdf"
    make_statement(path, "116.00")
    result = analyze(path.read_bytes(), "bsa_adcb_mismatch")
    assert "LEDGER_NOT_RECONCILED" in result["reasonCodes"]
    assert result["segments"][0]["reconciliation"]["status"] == "unreconciled"


def test_mixed_synthetic_and_adcb_pages_are_segmented(tmp_path):
    from sys import path
    path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    from create_demo_fixture import create

    synthetic = tmp_path / "synthetic.pdf"
    adcb = tmp_path / "adcb.pdf"
    combined = tmp_path / "mixed.pdf"
    create(synthetic)
    make_statement(adcb)
    writer = PdfWriter()
    for source in (synthetic, adcb):
        for page in PdfReader(source).pages:
            writer.add_page(page)
    with combined.open("wb") as output:
        writer.write(output)
    result = analyze(combined.read_bytes(), "bsa_mixed")
    assert len(result["segments"]) == 9
    assert result["coverage"]["pageCount"] == 9
    assert result["coverage"]["unsupportedPages"] == []
    adcb_segment = next(item for item in result["segments"] if item["bankId"] == "adcb")
    assert adcb_segment["pages"] == [9]
    assert adcb_segment["transactions"][0]["evidence"][0]["page"] == 9
    assert adcb_segment["reconciliation"]["status"] == "fully_reconciled"


def test_two_adcb_accounts_in_one_pdf_are_separate(tmp_path):
    paths = [tmp_path / "a.pdf", tmp_path / "b.pdf"]
    make_statement(paths[0], account="12345678901234")
    make_statement(paths[1], account="98765432109876")
    writer = PdfWriter()
    for source in paths:
        for page in PdfReader(source).pages:
            writer.add_page(page)
    output = tmp_path / "two.pdf"
    with output.open("wb") as file:
        writer.write(file)
    result = analyze(output.read_bytes(), "bsa_two_accounts")
    assert result["coverage"]["unsupportedPages"] == []
    assert len(result["segments"]) == 2
    assert {item["accountNumberMasked"][-4:] for item in result["segments"]} == {"1234", "9876"}
