from decimal import Decimal

from hypothesis import given, settings, strategies as st

from bsa.analytics import money, monthly_cash_flow
from bsa.engine import amount, parse_page


minor_units = st.integers(min_value=0, max_value=10**10)


def page(currency: str, opening: Decimal, credit: Decimal, debit: Decimal) -> str:
    middle = opening + credit
    closing = middle - debit
    return "\n".join([
        "AI7 SYNTHETIC BANK STATEMENT", "BANK: GOLD", "ACCOUNT: SYNTH1234", "OWNER: Test Owner",
        "OWNERSHIP: sole", "PRODUCT: current_account", f"CURRENCY: {currency}",
        "PERIOD: 2026-01-01..2026-01-31", f"OPENING: {opening:.2f}", f"CLOSING: {closing:.2f}",
        f"TXN|2026-01-02|CREDIT|{credit:.2f}|{middle:.2f}|C1|PAYROLL|Payer",
        f"TXN|2026-01-03|DEBIT|{debit:.2f}|{closing:.2f}|D1|RENT|Creditor",
    ])


@settings(max_examples=60)
@given(minor_units, minor_units)
def test_generated_credit_debit_ledger_reconciles_exactly(opening_minor, transfer_minor):
    opening = Decimal(opening_minor) / 100
    transfer = Decimal(transfer_minor) / 100
    segment = parse_page(page("AED", opening, transfer, transfer), 1, "doc_gold")
    assert segment.reconciliation["status"] == "fully_reconciled"
    assert Decimal(segment.closingBalance.value) == opening
    assert segment.reconciliation["rowErrorIds"] == []


@settings(max_examples=40)
@given(minor_units, minor_units)
def test_generated_currency_ledgers_never_combine(aed_minor, usd_minor):
    aed = Decimal(aed_minor) / 100
    usd = Decimal(usd_minor) / 100
    aed_segment = parse_page(page("AED", Decimal(0), aed, Decimal(0)), 1, "doc_gold")
    usd_segment = parse_page(page("USD", Decimal(0), usd, Decimal(0)), 2, "doc_gold")
    records = [(segment, row) for segment in (aed_segment, usd_segment) for row in segment.transactions]
    summaries = monthly_cash_flow(records, set())
    assert len(summaries) == 2
    assert {item["currency"]: item["grossCredits"]["value"] for item in summaries} == {
        "AED": f"{aed:.2f}", "USD": f"{usd:.2f}"}


@given(st.integers(min_value=-10**11, max_value=10**11))
def test_money_json_round_trip_preserves_minor_units(minor):
    value = Decimal(minor) / 100
    serialized = money(value, "AED", 2)
    parsed = amount(serialized["value"], serialized["currency"])
    assert Decimal(parsed.value) == value
    assert parsed.scale == 2


def test_account_fingerprint_is_stable_only_within_tenant():
    text = page("AED", Decimal("10.00"), Decimal("5.00"), Decimal("2.00"))
    first = parse_page(text, 1, "doc_first", tenant_scope="tenant_a")
    second = parse_page(text, 1, "doc_second", tenant_scope="tenant_a")
    other = parse_page(text, 1, "doc_third", tenant_scope="tenant_b")
    assert first.accountFingerprint == second.accountFingerprint
    assert first.accountId == second.accountId
    assert first.accountFingerprint != other.accountFingerprint
