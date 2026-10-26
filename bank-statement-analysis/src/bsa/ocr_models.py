"""Pinned RapidOCR 3.10.0 ONNX model manifest for offline worker execution."""

import hashlib
from pathlib import Path


MODEL_BASE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx"
MODELS = {
    "PP-OCRv6_det_small.onnx": ("PP-OCRv6/det", "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"),
    "PP-OCRv6_rec_small.onnx": ("PP-OCRv6/rec", "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"),
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": ("PP-OCRv4/cls", "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"),
    "arabic_PP-OCRv5_rec_mobile.onnx": ("PP-OCRv5/rec", "c1192e632d0baa9146ae5b756a0e635e3dc63c1733737ebfd1629e87144e9295"),
}


def verified_models(root: Path, names: tuple[str, ...]) -> bool:
    for name in names:
        path = root / name
        if name not in MODELS or not path.is_file():
            return False
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != MODELS[name][1]:
            return False
    return True
