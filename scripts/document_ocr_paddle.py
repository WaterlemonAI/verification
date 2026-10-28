"""Private document OCR extraction. Raw bytes enter on stdin; only page text leaves stdout."""

import argparse
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
import sys
from functools import lru_cache
from pathlib import Path

MODEL_SHA256 = {
    "english/detection/inference.onnx": "10803475a591f7dc623e24670fb5752ec94d39a1f8cf069aac1b6f0ce19cfc85",
    "english/recognition/inference.onnx": "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f",
    "arabic/recognition/inference.onnx": "799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110",
}


def model_root():
    return Path(os.environ.get("DOCUMENT_OCR_PADDLE_MODEL_ROOT", "/app/paddle-models"))


def models_ready(root=None):
    root = root or model_root()
    if not all((root / language / "ready").exists() for language in ("english", "arabic")):
        return False
    for relative, expected in MODEL_SHA256.items():
        path = root / relative
        if not path.is_file():
            return False
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                return False
    return True


@lru_cache(maxsize=2)
def engine(language):
    from paddleocr import PaddleOCR
    root = model_root()
    if not models_ready(root):
        raise RuntimeError("models unavailable")
    base = root / language
    return PaddleOCR(
        text_detection_model_name="PP-OCRv5_server_det",
        text_recognition_model_name=("arabic_PP-OCRv5_mobile_rec" if language == "arabic"
                                     else "en_PP-OCRv5_mobile_rec"),
        engine="onnxruntime", use_doc_orientation_classify=False,
        use_doc_unwarping=False, use_textline_orientation=False,
        text_detection_model_dir=str(base / "detection"),
        text_recognition_model_dir=str(base / "recognition"),
    )


def rows(payload):
    if callable(getattr(payload, "json", None)):
        payload = payload.json()
    elif hasattr(payload, "json"):
        payload = payload.json
    if isinstance(payload, dict):
        payload = payload.get("res", payload)
    if not isinstance(payload, dict):
        return []
    found = []
    for text, score, box in zip(payload.get("rec_texts", []), payload.get("rec_scores", []),
                                payload.get("rec_boxes", [])):
        if not isinstance(text, str) or not text.strip() or len(box) != 4:
            continue
        found.append((tuple(float(value) for value in box), text.strip(), float(score)))
    return found


def merged_text(image):
    observations = []
    for language in ("english", "arabic"):
        for result in engine(language).predict(image):
            observations.extend(rows(result))
    chosen = []
    for box, text, score in sorted(observations, key=lambda item: item[2], reverse=True):
        x0, y0, x1, y1 = box
        if x1 <= x0 or y1 <= y0:
            continue
        duplicate = False
        for prior, _, _ in chosen:
            px0, py0, px1, py1 = prior
            overlap = max(0, min(x1, px1) - max(x0, px0)) * max(0, min(y1, py1) - max(y0, py0))
            if overlap / min((x1 - x0) * (y1 - y0), (px1 - px0) * (py1 - py0)) > 0.6:
                duplicate = True
                break
        if not duplicate:
            chosen.append((box, text, score))
    chosen.sort(key=lambda item: (round(item[0][1] / 20), item[0][0]))
    return "\n".join(text for _, text, _ in chosen)[:80_000]


def extract(data, media_type, max_pages):
    import numpy as np
    from PIL import Image
    if media_type == "application/pdf":
        import pymupdf
        document = pymupdf.open(stream=data, filetype="pdf")
        if not 1 <= len(document) <= max_pages:
            raise ValueError("page limit")
        pages = []
        for index, page in enumerate(document):
            scale = min(1.7, (8_000_000 / max(1, page.rect.width * page.rect.height)) ** 0.5)
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            image = np.asarray(Image.open(io.BytesIO(pixmap.tobytes("png"))).convert("RGB"))
            pages.append({"page": index + 1, "text": merged_text(image)})
        return pages
    image = Image.open(io.BytesIO(data)).convert("RGB")
    if image.width * image.height > 8_000_000:
        image.thumbnail((2800, 2800))
    return [{"page": 1, "text": merged_text(np.asarray(image))}]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--media-type", choices=("application/pdf", "image/png", "image/jpeg"))
    parser.add_argument("--max-pages", type=int, default=50)
    args = parser.parse_args()
    if args.check:
        return 0 if models_ready() else 1
    if not args.media_type or not 1 <= args.max_pages <= 50:
        return 1
    data = sys.stdin.buffer.read(25 * 1024 * 1024 + 1)
    if not data or len(data) > 25 * 1024 * 1024:
        return 1
    try:
        with open(os.devnull, "w") as quiet, redirect_stdout(quiet):
            result = {"pages": extract(data, args.media_type, args.max_pages)}
    except Exception:
        return 1
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
