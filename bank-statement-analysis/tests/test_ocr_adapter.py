from bsa.ocr_adapter import parse_banque_misr_tokens


def token(text, x, y):
    return {"text": text, "x": x, "y": y, "x0": x - 0.01, "y0": y - 0.005,
            "x1": x + 0.01, "y1": y + 0.005, "confidence": 0.99}


def scanned_page(second_balance="110.00"):
    return [
        token("BANQUE MISR", 0.9, 0.06),
        token("Customer Name", 0.12, 0.05), token("EXAMPLE COMPANY", 0.36, 0.05),
        token("Account Number", 0.12, 0.12), token("12345678901234", 0.31, 0.12),
        token("Account Currency", 0.12, 0.14), token("AED", 0.28, 0.14),
        token("Previous Balance", 0.12, 0.18), token("100.00", 0.25, 0.18),
        token("Historical Statement from", 0.45, 0.18),
        token("01-01-2026", 0.63, 0.18), token("31-01-2026", 0.83, 0.18),
        token("02/01/2026", 0.16, 0.30), token("Debit purchase", 0.45, 0.30),
        token("10.00", 0.72, 0.30), token("90.00", 0.92, 0.30),
        token("03/01/2026", 0.16, 0.34), token("Deposit", 0.45, 0.34),
        token("20.00", 0.83, 0.34), token(second_balance, 0.92, 0.34),
    ]


def test_scanned_banque_misr_table_reconciles_exactly():
    segment, reasons = parse_banque_misr_tokens([scanned_page()], "doc_synthetic")
    assert segment is not None
    assert segment.reconciliation["status"] == "fully_reconciled"
    assert [item.creditDebitIndicator for item in segment.transactions] == ["DEBIT", "CREDIT"]
    assert [item.ledgerAmount.value for item in segment.transactions] == ["10.00", "20.00"]
    assert segment.closingBalance.value == "110.00"
    assert segment.accountNumberMasked.endswith("1234")
    assert segment.ownershipType == "unknown"
    assert reasons == ["OWNER_ATTRIBUTION_AMBIGUOUS"]
    assert segment.transactions[0].evidence[0].boundingBox is not None


def test_scanned_banque_misr_balance_mismatch_stays_unreconciled():
    segment, reasons = parse_banque_misr_tokens([scanned_page("111.00")], "doc_synthetic")
    assert segment is not None
    assert segment.reconciliation["status"] == "unreconciled"
    assert len(segment.reconciliation["rowErrorIds"]) == 1
    assert "LEDGER_NOT_RECONCILED" in reasons
