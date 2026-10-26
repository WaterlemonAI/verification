"""Review measures and XLSX export stay transparent and decision ineligible."""

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from create_demo_fixture import create  # noqa: E402

from bsa.credit_assessment import MODEL_IDS, assess  # noqa: E402
from bsa.engine import analyze  # noqa: E402
from bsa.xlsx_report import build_xlsx  # noqa: E402


def test_models_are_observations_and_review_rules_do_not_depend_on_selection(tmp_path):
    source = tmp_path / "statement.pdf"
    create(source)
    result = analyze(source.read_bytes(), "bsa_credit_test")
    complete = assess(result, list(MODEL_IDS))
    assert complete["creditDecision"] is None
    assert complete["decisionEligible"] is False
    assert {model["modelId"] for model in complete["models"]} == set(MODEL_IDS)
    assert next(model for model in complete["models"] if model["modelId"] == "residual_cash_flow")["status"] == "observed"
    assert all(next(model for model in complete["models"] if model["modelId"] == model_id)["status"] == "requires_external_verification"
               for model_id in ("uae_dbr", "business_dscr"))
    assert complete["riskHighlights"] == assess(result, [])["riskHighlights"]
    assert not any(item["code"] == "REPEATED_NEGATIVE_MONTHLY_CASH_FLOW" for item in complete["riskHighlights"])


def test_xlsx_has_auditable_sheets_and_never_executes_statement_text(tmp_path):
    source = tmp_path / "statement.pdf"
    create(source)
    result = analyze(source.read_bytes(), "bsa_workbook_test")
    result["creditAssessment"] = assess(result, list(MODEL_IDS))
    result["segments"][0]["transactions"][0]["descriptionRaw"] = '=HYPERLINK("https://invalid.example", "bad")'
    workbook = build_xlsx(result)
    with zipfile.ZipFile(io.BytesIO(workbook)) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert len([name for name in names if name.startswith("xl/worksheets/sheet")]) == 6
        for name in names:
            if name.endswith((".xml", ".rels")):
                ElementTree.fromstring(archive.read(name))
        transactions = archive.read("xl/worksheets/sheet5.xml").decode()
        assert 't="inlineStr"' in transactions
        assert '=HYPERLINK' in transactions
        assert '<f>HYPERLINK' not in transactions
        cash_flow = archive.read("xl/worksheets/sheet2.xml").decode()
        assert '<f>D6-E6</f>' in cash_flow
