import io
from uuid import UUID

import pytest
from pypdf import PdfWriter

from bsa.extraction import AzureLayoutExtractor, DocumentInput, ManagedLayoutFixtureExtractor
from bsa.layout_bridge import parse_layout_document
from bsa.engine import analyze


RESULT_ID = str(UUID("00000000-0000-4000-8000-000000000123"))
ENDPOINT = "https://fictional-uaenorth.cognitiveservices.azure.com"
RESULT_URL = (f"{ENDPOINT}/documentintelligence/documentModels/prebuilt-layout/"
              f"analyzeResults/{RESULT_ID}?api-version=2024-11-30")


def blank_pdf():
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def layout_payload():
    lines = [
        "Fictional Dune Bank", "Account Number 5544332211",
        "Statement Period From 13/01/2026 to 31/01/2026", "Currency AED",
        "Account Holder FICTIONAL CUSTOMER", "Opening Balance 100.00 AED",
        "Closing Balance 110.00 AED",
    ]
    rows = [
        ["Date", "Description", "Debit", "Credit", "Balance"],
        ["13/01/2026", "Shop", "10.00", "", "90.00"],
        ["14/01/2026", "Transfer", "", "20.00", "110.00"],
    ]
    cells = []
    for row_index, row in enumerate(rows):
        for column_index, text in enumerate(row):
            x0, x1 = 40 + column_index * 100, 130 + column_index * 100
            y0, y1 = 300 + row_index * 30, 322 + row_index * 30
            cells.append({"rowIndex": row_index, "columnIndex": column_index, "content": text,
                          "boundingRegions": [{"pageNumber": 1,
                                               "polygon": [x0, y0, x1, y0, x1, y1, x0, y1]}]})
    return {"status": "succeeded", "analyzeResult": {
        "modelId": "prebuilt-layout", "apiVersion": "2024-11-30",
        "pages": [{"pageNumber": 1, "width": 612, "height": 792,
                   "lines": [{"content": line, "polygon": [40, 50 + index * 25, 400, 50 + index * 25,
                                                            400, 65 + index * 25, 40, 65 + index * 25]}
                             for index, line in enumerate(lines)]}],
        "tables": [{"cells": cells}],
    }}


class Response:
    def __init__(self, status, payload=None, headers=None):
        self.status_code = status
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self):
        return self._payload


class Session:
    def __init__(self, location=RESULT_URL, delete_status=204):
        self.location = location
        self.delete_status = delete_status
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return Response(202, headers={"Operation-Location": self.location})

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return Response(200, layout_payload())

    def delete(self, url, **kwargs):
        self.calls.append(("DELETE", url, kwargs))
        return Response(self.delete_status)


def extractor(session, approved=True):
    return AzureLayoutExtractor(endpoint=ENDPOINT, api_key="fixture-only-key", resource_region="uaenorth",
                                approved_region="uaenorth", approved=approved, max_pages=2,
                                max_cost_usd="1.00", estimated_page_cost_usd="0.01",
                                session=session, poll_interval=0, max_polls=2)


def test_layout_v4_response_reaches_bank_neutral_reconciled_ledger():
    session = Session()
    document = extractor(session).analyze(DocumentInput(documentId="doc_fixture", data=blank_pdf()))
    assert [call[0] for call in session.calls] == ["POST", "GET", "DELETE"]
    assert "base64Source" in session.calls[0][2]["json"]
    assert "urlSource" not in session.calls[0][2]["json"]
    assert document.modelVersion == "prebuilt-layout:2024-11-30"
    assert document.pages[0].tables[0].cells[0].polygon[0][0] == round(40 / 612, 4)
    segments, reasons, uncovered = parse_layout_document(document, "local-test")
    assert uncovered == []
    assert len(segments) == 1
    assert segments[0].reconciliation["status"] == "fully_reconciled"
    assert len(segments[0].transactions) == 2
    assert segments[0].transactions[0].evidence[0].extractionMethod == AzureLayoutExtractor.version
    assert "OWNER_ATTRIBUTION_AMBIGUOUS" in reasons


def test_worker_engine_uses_managed_layout_for_scanned_page_fixture():
    session = Session()
    result = analyze(blank_pdf(), "bsa_layout_fixture", tenant_scope="local-test",
                     layout_extractor=extractor(session))
    assert result["coverage"]["unsupportedPages"] == []
    assert result["coverage"]["transactionCount"] == 2
    assert result["quality"]["reconciledSegments"] == 1
    assert result["versions"]["extractor"] == AzureLayoutExtractor.version
    assert [call[0] for call in session.calls] == ["POST", "GET", "DELETE"]


def test_layout_gate_prevents_unapproved_network_call():
    session = Session()
    with pytest.raises(ValueError, match="MANAGED_EXTRACTION_NOT_APPROVED"):
        extractor(session, approved=False).analyze(DocumentInput(documentId="doc_fixture", data=blank_pdf()))
    assert session.calls == []


def test_layout_rejects_foreign_poll_url():
    session = Session(location="https://untrusted.example/analyzeResults/" + RESULT_ID)
    with pytest.raises(ValueError, match="MANAGED_EXTRACTION_RESULT_URL_INVALID"):
        extractor(session).analyze(DocumentInput(documentId="doc_fixture", data=blank_pdf()))
    assert [call[0] for call in session.calls] == ["POST"]


def test_layout_requires_provider_result_deletion():
    session = Session(delete_status=500)
    with pytest.raises(ValueError, match="MANAGED_EXTRACTION_DELETE_FAILED"):
        extractor(session).analyze(DocumentInput(documentId="doc_fixture", data=blank_pdf()))
    assert session.calls[-1][0] == "DELETE"


def test_layout_uses_managed_identity_bearer_token_without_a_local_key():
    session = Session()
    managed = AzureLayoutExtractor(endpoint=ENDPOINT, token_provider=lambda: "managed-token",
                                   resource_region="uaenorth", approved_region="uaenorth",
                                   approved=True, max_pages=2, max_cost_usd="0.01",
                                   estimated_page_cost_usd="0", session=session,
                                   poll_interval=0, max_polls=2)
    managed.analyze(DocumentInput(documentId="doc_fixture", data=blank_pdf()))
    headers = session.calls[0][2]["headers"]
    assert headers["Authorization"] == "Bearer managed-token"
    assert "Ocp-Apim-Subscription-Key" not in headers


def test_layout_fixture_uses_same_provider_neutral_contract():
    response = layout_payload()["analyzeResult"]
    page = response["pages"][0]
    fixture = {"documentId": "doc_fixture", "extractionMethod": "managed_layout_fixture",
               "extractorVersion": "managed-layout-fixture-v1", "pages": [{
                   "pageNumber": 1, "text": "\n".join(line["content"] for line in page["lines"]),
                   "lines": [line["content"] for line in page["lines"]],
                   "width": 612, "height": 792}]}
    result = ManagedLayoutFixtureExtractor(fixture).analyze(DocumentInput(documentId="doc_fixture", data=blank_pdf()))
    assert result.pages[0].lines[0] == "Fictional Dune Bank"
