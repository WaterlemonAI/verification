from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from create_demo_fixture import create  # noqa: E402

from bsa.engine import analyze, detect_circular_flows  # noqa: E402
from bsa.inputs import normalize_inputs  # noqa: E402
from bsa.analytics import normalize_name  # noqa: E402


def test_combined_statement_accounting_and_income(tmp_path):
    sample = tmp_path / "synthetic.pdf"
    create(sample)
    result = analyze(sample.read_bytes(), "bsa_test")
    assert result["status"] == "partial"
    assert "JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED" in result["reasonCodes"]
    assert result["coverage"]["pageCount"] == 8
    assert result["coverage"]["transactionCount"] == 16
    assert len(result["duplicates"]) == 3
    assert len(result["transfers"]) == 3
    assert result["coverageMatrix"][0]["overlapDetected"]
    assert len(result["features"]["salaryStreams"]) == 1
    assert result["features"]["salaryStreams"][0]["stable"]
    assert result["features"]["salaryStreams"][0]["candidateMonthlyAmount"]["value"] == "18000.00"
    assert all(segment["reconciliation"]["status"] == "fully_reconciled" for segment in result["segments"])
    assert any(item["reasonCode"] == "JOINT_ACCOUNT_INCOME_NOT_ATTRIBUTED" for item in result["features"]["excludedCredits"])
    assert len(result["accounts"]) == 3
    assert len(result["dailyBalances"]) == 208
    assert len(result["observedObligations"]) == 1
    assert result["observedObligations"][0]["category"] == "rent"
    assert result["observedObligations"][0]["typicalAmount"]["value"] == "3000.00"
    assert result["observedEmployers"][0]["observedEmployer"] == "example employer"
    assert result["observedEmployers"][0]["missingMonthsInSpan"] == 0
    assert result["documents"]["duplicatePageGroups"][0]["signal"] == "DUPLICATE_STATEMENT_PAGE"
    assert all(signal["fraudConclusion"] is False for signal in result["irregularities"])
    assert all(row["currency"] == "USD" for row in result["monthlyCashFlow"] if row["accountId"] == result["segments"][6]["accountId"])


def test_bad_running_balance_fails_closed(tmp_path):
    from reportlab.pdfgen import canvas

    path = tmp_path / "bad.pdf"
    pdf = canvas.Canvas(str(path))
    for index, line in enumerate([
        "AI7 SYNTHETIC BANK STATEMENT", "BANK: TEST", "ACCOUNT: 1234", "OWNER: Demo", "OWNERSHIP: sole",
        "PRODUCT: current_account", "CURRENCY: AED", "PERIOD: 2026-01-01..2026-01-31",
        "OPENING: 100.00", "CLOSING: 200.00", "TXN|2026-01-02|CREDIT|100.00|199.00|A|SALARY|Employer",
    ]):
        pdf.drawString(36, 750 - index * 18, line)
    pdf.save()
    result = analyze(path.read_bytes(), "bsa_bad")
    assert result["status"] == "partial"
    assert not result["decisionEligible"]
    assert "LEDGER_NOT_RECONCILED" in result["reasonCodes"]


def test_bounded_self_owned_cycle_is_a_flow_fact_not_a_fraud_claim():
    money = {"value": "100.00", "currency": "AED", "scale": 2}
    transfers = [
        {"fromAccountId": "a", "toAccountId": "b", "amount": money, "transactionIds": ["x1", "x2"], "bookingDate": "2026-01-01"},
        {"fromAccountId": "b", "toAccountId": "a", "amount": money, "transactionIds": ["x3", "x4"], "bookingDate": "2026-01-02"},
    ]
    flows = detect_circular_flows(transfers)
    assert len(flows) == 1
    assert flows[0]["netNewMoney"]["value"] == "0.00"
    assert flows[0]["fraudConclusion"] is False


def test_image_bundle_normalization_and_pixel_gate():
    from io import BytesIO
    from PIL import Image
    from pypdf import PdfReader

    image = Image.new("RGB", (20, 30), "white")
    encoded = BytesIO()
    image.save(encoded, format="PNG")
    pdf = normalize_inputs([("image/png", encoded.getvalue()), ("image/png", encoded.getvalue())])
    assert len(PdfReader(BytesIO(pdf)).pages) == 2
    try:
        normalize_inputs([("image/png", encoded.getvalue())], max_pixels_per_page=100)
    except ValueError as error:
        assert str(error) == "IMAGE_PIXEL_LIMIT_EXCEEDED"
    else:
        assert False, "oversized image should be rejected"


def test_counterparty_normalization_handles_arabic_digits_and_marks():
    assert normalize_name("شركة  أَمَل، ١٢٣") == "شركة امل 123"


def test_multi_hop_and_split_cycles_remain_review_signals():
    def edge(source, target, value, number, day):
        return {"fromAccountId": source, "toAccountId": target,
                "amount": {"value": value, "currency": "AED", "scale": 2},
                "transactionIds": [f"t{number}a", f"t{number}b"], "bookingDate": f"2026-01-{day:02d}"}

    flows = detect_circular_flows([edge("a", "b", "60.00", 1, 1), edge("a", "c", "40.00", 2, 1),
                                   edge("b", "a", "60.00", 3, 2), edge("c", "a", "40.00", 4, 2),
                                   edge("d", "e", "10.00", 5, 3), edge("e", "f", "10.00", 6, 4),
                                   edge("f", "d", "10.00", 7, 5)])
    assert {flow["classification"] for flow in flows} >= {"split_recombine_cycle", "multi_hop_cycle"}
    assert all(flow["fraudConclusion"] is False and flow["netNewMoney"]["value"] == "0.00" for flow in flows)
    savings = edge("a", "savings", "100.00", 8, 1)
    savings["descriptionRaw"] = "Transfer to savings"
    assert not detect_circular_flows([savings, edge("savings", "a", "100.00", 9, 2)])
