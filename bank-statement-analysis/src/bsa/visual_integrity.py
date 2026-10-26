"""Compare native PDF text with independently OCR-read rendered pages."""

import io
import re
import unicodedata

import pymupdf
from pypdf import PdfReader

from .ocr_adapter import _ocr_engine


VERSION = "rendered-native-comparison-v1"
TOKEN = re.compile(r"[a-zA-Z]{4,}|\d[\d,.]{2,}")
NUMBER = re.compile(r"\d[\d,]*(?:\.\d{2,3})")


def _tokens(text: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return {match.group().replace(",", "").rstrip(".,") for match in TOKEN.finditer(normalized)}


def compare_pdf_text_to_render(data: bytes, max_pages: int = 12) -> dict:
    """Return page indices only; never retain or log raw OCR or statement text."""
    native = PdfReader(io.BytesIO(data), strict=True)
    rendered = pymupdf.open(stream=data, filetype="pdf")
    if len(native.pages) != len(rendered):
        raise ValueError("VISUAL_TEXT_CHECK_FAILED")
    checked, inconclusive, mismatches = [], [], []
    engine = None
    for index, page in enumerate(native.pages):
        number = index + 1
        native_tokens = _tokens(page.extract_text() or "")
        if len(native_tokens) < 8:
            continue
        if number > max_pages:
            inconclusive.append(number)
            continue
        try:
            if engine is None:
                engine = _ocr_engine()
            pixmap = rendered[index].get_pixmap(matrix=pymupdf.Matrix(1.3, 1.3), alpha=False)
            output = engine(pixmap.tobytes("png"))
            visible_text = " ".join(str(text) for text, score in zip(output.txts, output.scores)
                                    if float(score) >= 0.85)
            visible_tokens = _tokens(visible_text)
        except Exception:
            inconclusive.append(number)
            continue
        if len(visible_tokens) < 8:
            inconclusive.append(number)
            continue
        checked.append(number)
        overlap = len(native_tokens & visible_tokens) / min(len(native_tokens), len(visible_tokens))
        native_numbers = {value.replace(",", "") for value in NUMBER.findall(page.extract_text() or "")}
        visible_numbers = {value.replace(",", "") for value in NUMBER.findall(visible_text)}
        numeric_conflict = (len(native_numbers) >= 3 and len(visible_numbers) >= 3
                            and not native_numbers & visible_numbers)
        if overlap < 0.30 or (overlap < 0.60 and numeric_conflict):
            mismatches.append(number)
    return {"methodVersion": VERSION, "checkedPages": checked,
            "inconclusivePages": inconclusive, "mismatchPages": mismatches}
