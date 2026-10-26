"""Generate a wholly synthetic combined statement for the local demo."""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


STATEMENTS = [
    ("GULF-DEMO", "DEMO1001", "Alex Sample", "sole", "current_account", "AED", "2026-01-01..2026-01-31", "10000.00", "21000.00", [
        "TXN|2026-01-25|CREDIT|18000.00|28000.00|PAY-JAN|SALARY JANUARY|Example Employer",
        "TXN|2026-01-27|DEBIT|2000.00|26000.00|BILL-JAN|RENT|Property Demo",
        "TXN|2026-01-29|DEBIT|5000.00|21000.00|MOVE-JAN|TRANSFER TO SAVINGS|Alex Sample",
    ]),
    ("GULF-DEMO", "DEMO1001", "Alex Sample", "sole", "current_account", "AED", "2026-02-01..2026-02-28", "21000.00", "32000.00", [
        "TXN|2026-02-25|CREDIT|18000.00|39000.00|PAY-FEB|SALARY FEBRUARY|Example Employer",
        "TXN|2026-02-26|DEBIT|3000.00|36000.00|BILL-FEB|RENT|Property Demo",
        "TXN|2026-02-27|DEBIT|4000.00|32000.00|MOVE-FEB|TRANSFER TO SAVINGS|Alex Sample",
    ]),
    ("GULF-DEMO", "DEMO1001", "Alex Sample", "sole", "current_account", "AED", "2026-03-01..2026-03-31", "32000.00", "44000.00", [
        "TXN|2026-03-25|CREDIT|18000.00|50000.00|PAY-MAR|SALARY MARCH|Example Employer",
        "TXN|2026-03-26|DEBIT|3000.00|47000.00|BILL-MAR|RENT|Property Demo",
        "TXN|2026-03-27|DEBIT|3000.00|44000.00|MOVE-MAR|TRANSFER TO SAVINGS|Alex Sample",
    ]),
    ("OASIS-DEMO", "DEMO2002", "Alex Sample", "sole", "savings_account", "AED", "2026-01-01..2026-01-31", "2000.00", "6000.00", [
        "TXN|2026-01-29|CREDIT|5000.00|7000.00|MOVE-JAN|TRANSFER FROM CURRENT|Alex Sample",
        "TXN|2026-01-30|DEBIT|1000.00|6000.00|BUY-JAN|PURCHASE|Shop Demo",
    ]),
    ("OASIS-DEMO", "DEMO2002", "Alex Sample", "sole", "savings_account", "AED", "2026-02-01..2026-02-28", "6000.00", "9000.00", [
        "TXN|2026-02-27|CREDIT|4000.00|10000.00|MOVE-FEB|TRANSFER FROM CURRENT|Alex Sample",
        "TXN|2026-02-28|DEBIT|1000.00|9000.00|BUY-FEB|PURCHASE|Shop Demo",
    ]),
    ("OASIS-DEMO", "DEMO2002", "Alex Sample", "sole", "savings_account", "AED", "2026-03-01..2026-03-31", "9000.00", "11000.00", [
        "TXN|2026-03-27|CREDIT|3000.00|12000.00|MOVE-MAR|TRANSFER FROM CURRENT|Alex Sample",
        "TXN|2026-03-28|DEBIT|1000.00|11000.00|BUY-MAR|PURCHASE|Shop Demo",
    ]),
    ("COASTAL-DEMO", "DEMO3003", "Alex Sample and Jamie Sample", "joint", "current_account", "USD", "2026-02-01..2026-02-28", "1000.00", "3000.00", [
        "TXN|2026-02-25|CREDIT|2000.00|3000.00|PAY-JOINT|SALARY FEBRUARY|Other Employer",
    ]),
]


def create(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=A4)
    for bank, account, owner, ownership, product, currency, period, opening, closing, rows in [*STATEMENTS, STATEMENTS[1]]:
        lines = ["AI7 SYNTHETIC BANK STATEMENT", f"BANK: {bank}", f"ACCOUNT: {account}",
                 f"OWNER: {owner}", f"OWNERSHIP: {ownership}", f"PRODUCT: {product}",
                 f"CURRENCY: {currency}", f"PERIOD: {period}", f"OPENING: {opening}", f"CLOSING: {closing}", *rows]
        pdf.setFont("Courier", 8)
        y = A4[1] - 50
        for line in lines:
            pdf.drawString(36, y, line)
            y -= 20
        pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    create(Path(__file__).resolve().parents[2] / "test" / "fixtures" / "bsa-synthetic-combined.pdf")
