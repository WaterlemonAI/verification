from pathlib import Path

from reportlab.pdfgen import canvas

from bsa.engine import analyze


def _page(pdf, *, bank, account, product, opening, closing, extra, rows):
    lines = ["AI7 SYNTHETIC BANK STATEMENT", f"BANK: {bank}", f"ACCOUNT: {account}",
             "OWNER: Test Owner", "OWNERSHIP: sole", f"PRODUCT: {product}", "CURRENCY: AED",
             "PERIOD: 2026-01-01..2026-01-31", f"OPENING: {opening}", f"CLOSING: {closing}",
             *extra, *rows]
    pdf.setFont("Courier", 8)
    for index, line in enumerate(lines):
        pdf.drawString(36, 760 - 18 * index, line)
    pdf.showPage()


def test_facilities_are_separate_from_deposit_liquidity_and_income(tmp_path: Path):
    path = tmp_path / "products.pdf"
    pdf = canvas.Canvas(str(path))
    _page(pdf, bank="DEMO", account="CURRENT1001", product="current_account", opening="-1000.00",
          closing="-500.00", extra=["OVERDRAFT_LIMIT: 3000.00"], rows=[
              "TXN|2026-01-10|CREDIT|1000.00|0.00|R1|REFUND|Store",
              "TXN|2026-01-11|DEBIT|500.00|-500.00|R2|RENT|Landlord"])
    _page(pdf, bank="DEMO", account="CARD2002", product="credit_card", opening="-2000.00",
          closing="-2500.00", extra=["CREDIT_LIMIT: 10000.00"], rows=[
              "TXN|2026-01-15|DEBIT|500.00|-2500.00|R3|CARD PURCHASE|Shop"])
    _page(pdf, bank="DEMO", account="LOAN3003", product="loan", opening="-5000.00",
          closing="-4800.00", extra=[], rows=[
              "TXN|2026-01-20|CREDIT|200.00|-4800.00|R4|LOAN REPAYMENT|Owner"])
    pdf.save()
    result = analyze(path.read_bytes(), "bsa_products")
    assert all(item["reconciliation"]["status"] == "fully_reconciled" for item in result["segments"])
    assert {item["facilityType"] for item in result["facilities"]} == {"overdraft", "credit_card", "loan"}
    card = next(item for item in result["facilities"] if item["facilityType"] == "credit_card")
    assert card["utilized"]["value"] == "2500.00"
    assert card["available"]["value"] == "7500.00"
    assert len(result["liquidity"]) == 1
    assert result["features"]["salaryStreams"] == []
    assert result["features"]["observedExpensesByCurrency"] == [{"value": "500.00", "currency": "AED", "scale": 2}]
