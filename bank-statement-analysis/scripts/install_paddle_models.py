"""Download PaddleOCR ONNX inference models while building the worker image."""

import argparse
import shutil
from pathlib import Path

from paddlex.inference.utils.official_models import official_models
from bsa.paddle_ocr import verified_paddle_models


MODELS = {
    "detection": "PP-OCRv5_server_det",
    "english": "en_PP-OCRv5_mobile_rec",
    "arabic": "arabic_PP-OCRv5_mobile_rec",
}


def install(target: Path) -> None:
    paths = {name: Path(official_models.get_model_path(model, model_formats=["onnx"]))
             for name, model in MODELS.items()}
    for language in ("english", "arabic"):
        base = target / language
        shutil.copytree(paths["detection"], base / "detection", dirs_exist_ok=True)
        shutil.copytree(paths[language], base / "recognition", dirs_exist_ok=True)
        if not (base / "detection" / "inference.onnx").exists() or not (base / "recognition" / "inference.onnx").exists():
            raise RuntimeError("PaddleOCR ONNX model download incomplete")
        (base / "ready").touch()
    if not verified_paddle_models(target):
        raise RuntimeError("PaddleOCR model checksum mismatch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, required=True)
    install(parser.parse_args().target)
