"""Download pinned OCR models during image build, never during worker execution."""

import argparse
import hashlib
from pathlib import Path

import requests

from bsa.ocr_models import MODEL_BASE, MODELS


def install(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for name, (route, expected) in MODELS.items():
        destination = root / name
        if destination.exists():
            with destination.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() == expected:
                    continue
        temporary = root / f"{name}.download"
        temporary.unlink(missing_ok=True)
        try:
            with requests.get(f"{MODEL_BASE}/{route}/{name}", stream=True, timeout=(10, 120)) as response:
                response.raise_for_status()
                digest = hashlib.sha256()
                total = 0
                with temporary.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        total += len(chunk)
                        if total > 100 * 1024 * 1024:
                            raise ValueError("OCR_MODEL_TOO_LARGE")
                        digest.update(chunk)
                        output.write(chunk)
                if digest.hexdigest() != expected:
                    raise ValueError(f"OCR_MODEL_CHECKSUM_MISMATCH: {name}")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, required=True)
    install(parser.parse_args().target)
