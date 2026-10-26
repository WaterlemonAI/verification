"""Private OCR bridge into the bank-neutral, reconciliation-gated table parser."""

import re

from .generic_adapter import parse_generic_pages


METHOD = "rapidocr-generic-table-v1"


class OCRPage:
    line_tolerance = 0.018

    def __init__(self, source_tokens: list[dict]):
        self.width = 1
        self.height = 1
        self.tokens = []
        for item in source_tokens:
            if not str(item["text"]).strip() or float(item["confidence"]) < 0.60:
                continue
            self.tokens.append({"text": str(item["text"]).strip(), "x0": item["x0"], "x1": item["x1"],
                                "top": item["y0"], "bottom": item["y1"]})

    def _lines(self):
        lines = []
        for token in sorted(self.tokens, key=lambda item: (item["top"], item["x0"])):
            if not lines or abs(token["top"] - lines[-1][0]["top"]) > self.line_tolerance:
                lines.append([])
            lines[-1].append(token)
        return [sorted(line, key=lambda item: item["x0"]) for line in lines]

    def extract_text(self):
        return "\n".join(" ".join(token["text"] for token in line) for line in self._lines())

    def extract_words(self):
        words = []
        for token in self.tokens:
            parts = list(re.finditer(r"\S+", token["text"]))
            if not parts:
                continue
            total = len(token["text"])
            width = token["x1"] - token["x0"]
            for part in parts:
                words.append({"text": part.group(), "x0": token["x0"] + width * part.start() / total,
                              "x1": token["x0"] + width * part.end() / total,
                              "top": token["top"], "bottom": token["bottom"]})
        return words

    def find_tables(self, **_kwargs):
        return []

    def search(self, pattern, **_kwargs):
        expression = re.compile(pattern)
        for line in self._lines():
            joined = " ".join(token["text"] for token in line)
            if expression.search(joined):
                return [{"x0": min(token["x0"] for token in line),
                         "x1": max(token["x1"] for token in line),
                         "top": min(token["top"] for token in line),
                         "bottom": max(token["bottom"] for token in line)}]
        return []


def parse_scanned_generic(tokens: list[list[dict]], document_id: str, tenant_scope: str | None = None,
                          method: str = METHOD):
    pages = [OCRPage(page) for page in tokens]
    return parse_generic_pages(pages, document_id, tenant_scope, method)
