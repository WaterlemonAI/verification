from types import SimpleNamespace

from bsa.paddle_ocr import _items
from bsa.capabilities import worker_capabilities


def test_paddle_result_coordinates_and_confidence_are_normalized():
    result = SimpleNamespace(json={"res": {"rec_texts": ["AED 100.00"], "rec_scores": [0.94],
                                          "rec_boxes": [[20, 40, 120, 60]]}})
    assert _items(result, 200, 100) == [{"text": "AED 100.00", "x": 0.35, "y": 0.5,
                                         "x0": 0.1, "y0": 0.4, "x1": 0.6, "y1": 0.6,
                                         "confidence": 0.94}]


def test_azure_status_requires_valid_region_and_cost_policy(monkeypatch):
    values = {
        "BSA_MANAGED_EXTRACTION_APPROVED": "1",
        "BSA_AZURE_LAYOUT_ENDPOINT": "https://example.cognitiveservices.azure.com",
        "BSA_AZURE_LAYOUT_KEY": "local-fixture-key",
        "BSA_AZURE_LAYOUT_REGION": "uaenorth",
        "BSA_APPROVED_PROCESSING_REGION": "uaenorth",
        "BSA_MANAGED_MAX_PAGES": "10",
        "BSA_MANAGED_MAX_COST_USD": "1.00",
        "BSA_MANAGED_ESTIMATED_PAGE_COST_USD": "0.01",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    assert worker_capabilities()["azureLayout"] == "configured"
    monkeypatch.setenv("BSA_MANAGED_MAX_PAGES", "0")
    assert worker_capabilities()["azureLayout"] == "unavailable"
