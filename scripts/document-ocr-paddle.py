"""Private PaddleOCR adapter. Input bytes on stdin; bounded, structured text on stdout."""

import io
import json
import os
import sys
import contextlib
from pathlib import Path

from bsa.paddle_ocr import _engine, _items, verified_paddle_models


def main():
    if sys.argv[1:] == ["--check"]:
        root = Path(os.environ.get("BSA_PADDLE_MODEL_ROOT", "/nonexistent"))
        ready = verified_paddle_models(root)
        if ready:
            import numpy as np
            image = np.zeros((64, 128, 3), dtype=np.uint8)
            with contextlib.redirect_stdout(sys.stderr):
                for language in ("english", "arabic"):
                    list(_engine(language).predict(image))
        print(json.dumps({"ready": ready}))
        return
    if len(sys.argv) != 3 or sys.argv[1] not in {"application/pdf", "image/png", "image/jpeg"}:
        raise ValueError("PADDLE_INPUT_INVALID")
    max_pages = int(sys.argv[2])
    if not 1 <= max_pages <= 50:
        raise ValueError("PADDLE_PAGE_LIMIT")
    data = sys.stdin.buffer.read(25 * 1024 * 1024 + 1)
    if not data or len(data) > 25 * 1024 * 1024:
        raise ValueError("PADDLE_INPUT_LIMIT")

    import numpy as np
    import pymupdf
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 25_000_000

    if sys.argv[1] == "application/pdf":
        document = pymupdf.open(stream=data, filetype="pdf")
        if len(document) > max_pages:
            raise ValueError("PADDLE_PAGE_LIMIT")
        def rendered_pages():
            for page in document:
                if page.rect.width * page.rect.height * 1.7 * 1.7 > 25_000_000:
                    raise ValueError("PADDLE_IMAGE_LIMIT")
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1.7, 1.7), alpha=False)
                yield np.asarray(Image.open(io.BytesIO(pixmap.tobytes("png"))).convert("RGB"))
        images = rendered_pages()
    else:
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > 25_000_000:
            raise ValueError("PADDLE_IMAGE_LIMIT")
        image = image.convert("RGB")
        images = [np.asarray(image)]
    pages = []
    for number, image in enumerate(images, 1):
        height, width = image.shape[:2]
        if width * height > 25_000_000:
            raise ValueError("PADDLE_IMAGE_LIMIT")
        items = []
        with contextlib.redirect_stdout(sys.stderr):
            for language in ("english", "arabic"):
                for result in _engine(language).predict(image):
                    items.extend(_items(result, width, height))
        # Keep one transcription for near-identical regions; preserve script when distinct.
        selected = []
        for item in sorted(items, key=lambda entry: (-entry["confidence"], entry["y"], entry["x"])):
            if item["confidence"] < 0.25:
                continue
            if any(abs(item["x"] - prior["x"]) < 0.02 and abs(item["y"] - prior["y"]) < 0.02
                   and item["text"] == prior["text"] for prior in selected):
                continue
            selected.append(item)
        ordered = sorted(selected, key=lambda entry: (round(entry["y"] * 100),
                         -entry["x"] if any("\u0600" <= c <= "\u06ff" for c in entry["text"]) else entry["x"]))
        lines = [{"text": entry["text"], "box": [max(0, min(1000, round(entry[key] * 1000)))
                  for key in ("x0", "y0", "x1", "y1")]} for entry in ordered]
        pages.append({"page": number, "lines": lines})
    print(json.dumps({"pages": pages}, ensure_ascii=False))


if __name__ == "__main__":
    main()
