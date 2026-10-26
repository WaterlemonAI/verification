"""Non-secret worker readiness snapshot for the admin module."""

import importlib.util
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

from .ocr_models import verified_models
from .ocr_adapter import _model_root
from .paddle_ocr import verified_paddle_models


def worker_capabilities() -> dict:
    rapid_root = _model_root()
    paddle_root = Path(os.environ["BSA_PADDLE_MODEL_ROOT"]) if os.getenv("BSA_PADDLE_MODEL_ROOT") else None
    rapid = importlib.util.find_spec("rapidocr") is not None and rapid_root.is_dir() and verified_models(
        rapid_root, ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx"))
    paddle = importlib.util.find_spec("paddleocr") is not None and paddle_root is not None and verified_paddle_models(paddle_root)
    azure_names = ("BSA_AZURE_LAYOUT_ENDPOINT", "BSA_AZURE_LAYOUT_REGION",
                   "BSA_APPROVED_PROCESSING_REGION", "BSA_MANAGED_MAX_PAGES", "BSA_MANAGED_MAX_COST_USD",
                   "BSA_MANAGED_ESTIMATED_PAGE_COST_USD")
    azure_auth = os.getenv("BSA_AZURE_LAYOUT_KEY") or os.getenv("BSA_WORKER_IDENTITY_CLIENT_ID")
    azure = os.getenv("BSA_MANAGED_EXTRACTION_APPROVED") == "1" and bool(azure_auth) and all(os.getenv(name) for name in azure_names)
    if azure:
        parsed = urlparse(os.environ["BSA_AZURE_LAYOUT_ENDPOINT"])
        try:
            pages = int(os.environ["BSA_MANAGED_MAX_PAGES"])
            ceiling = Decimal(os.environ["BSA_MANAGED_MAX_COST_USD"])
            page_cost = Decimal(os.environ["BSA_MANAGED_ESTIMATED_PAGE_COST_USD"])
        except (ValueError, InvalidOperation):
            azure = False
        else:
            azure = (os.getenv("BSA_AZURE_LAYOUT_REGION") == os.getenv("BSA_APPROVED_PROCESSING_REGION")
                     and pages > 0 and ceiling.is_finite() and page_cost.is_finite()
                     and ceiling > 0 and page_cost >= 0 and parsed.scheme == "https"
                     and parsed.hostname is not None and
                     (parsed.hostname.endswith(".cognitiveservices.azure.com") or
                      parsed.hostname.endswith(".api.cognitive.microsoft.com"))
                     and not parsed.username and not parsed.password and not parsed.query
                     and not parsed.fragment and parsed.path in {"", "/"})
    return {"native": "ready", "rapidocr": "ready" if rapid else "unavailable",
            "paddleocr": "ready" if paddle else "unavailable",
            "azureLayout": "configured" if azure else "unavailable"}
