"""Optional private PaddleOCR path for scanned statement pages.

The output uses the same normalized coordinates as the RapidOCR adapter so
the bank-neutral table inference and reconciliation gates remain unchanged.
"""

import io
import os
import hashlib
from functools import lru_cache
from pathlib import Path


MODEL_SHA256 = {
    "english/detection/inference.onnx": "10803475a591f7dc623e24670fb5752ec94d39a1f8cf069aac1b6f0ce19cfc85",
    "english/recognition/inference.onnx": "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f",
    "arabic/recognition/inference.onnx": "799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110",
}


def verified_paddle_models(root: Path) -> bool:
    if not all((root / lang / "ready").exists() for lang in ("english", "arabic")):
        return False
    for relative, expected in MODEL_SHA256.items():
        path = root / relative
        if not path.is_file():
            return False
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != expected:
            return False
    return True


@lru_cache(maxsize=2)
def _engine(language: str):
    from paddleocr import PaddleOCR

    configured = os.getenv("BSA_PADDLE_MODEL_ROOT")
    root = Path(configured) if configured else None
    if root is None or not root.is_dir() or not verified_paddle_models(root):
        raise ValueError("PADDLE_MODEL_UNAVAILABLE")
    return PaddleOCR(
        text_detection_model_name="PP-OCRv5_server_det",
        text_recognition_model_name="arabic_PP-OCRv5_mobile_rec" if language == "arabic" else "en_PP-OCRv5_mobile_rec",
        engine="onnxruntime",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_dir=str(root / language / "detection"),
        text_recognition_model_dir=str(root / language / "recognition"),
    )


def _items(result: object, width: int, height: int) -> list[dict]:
    payload = getattr(result, "json", result)
    if callable(payload):
        payload = payload()
    if isinstance(payload, dict):
        payload = payload.get("res", payload)
    if not isinstance(payload, dict):
        return []
    items = []
    for text, score, box in zip(payload.get("rec_texts", []), payload.get("rec_scores", []),
                                payload.get("rec_boxes", [])):
        if not text or len(box) != 4:
            continue
        x0, y0, x1, y1 = (float(value) for value in box)
        items.append({"text": str(text), "x": (x0 + x1) / (2 * width),
                      "y": (y0 + y1) / (2 * height), "x0": x0 / width,
                      "y0": y0 / height, "x1": x1 / width, "y1": y1 / height,
                      "confidence": float(score)})
    return items


def extract_paddle_tokens(data: bytes, language: str = "english") -> list[list[dict]]:
    try:
        import pymupdf
        from PIL import Image
        import numpy as np
    except ImportError as error:
        raise ValueError("PADDLE_OCR_UNAVAILABLE") from error
    if language not in {"english", "arabic"}:
        raise ValueError("PADDLE_LANGUAGE_UNSUPPORTED")
    document = pymupdf.open(stream=data, filetype="pdf")
    if len(document) > 10:
        raise ValueError("OCR_PAGE_LIMIT_EXCEEDED")
    try:
        engine = _engine(language)
    except ImportError as error:
        raise ValueError("PADDLE_OCR_UNAVAILABLE") from error
    pages = []
    for page in document:
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1.7, 1.7), alpha=False)
        image = np.asarray(Image.open(io.BytesIO(pixmap.tobytes("png"))).convert("RGB"))
        results = engine.predict(image)
        pages.append([item for result in results for item in _items(result, pixmap.width, pixmap.height)])
    return pages
