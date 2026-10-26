"""Expose provider-neutral Layout pages to the bank-neutral ledger parser."""

import re
from types import SimpleNamespace

from .extraction import ExtractedDocument, ExtractedTable
from .generic_adapter import parse_generic_pages


def _box(polygon):
    if not polygon:
        return None
    xs = [point[0] for point in polygon]
    ys = [point[1] for point in polygon]
    return min(xs), min(ys), max(xs), max(ys)


class LayoutTable:
    def __init__(self, table: ExtractedTable):
        row_count = max((cell.row for cell in table.cells), default=-1) + 1
        column_count = max((cell.column for cell in table.cells), default=-1) + 1
        self.matrix = [["" for _ in range(column_count)] for _ in range(row_count)]
        row_boxes = [[] for _ in range(row_count)]
        for cell in table.cells:
            self.matrix[cell.row][cell.column] = cell.text
            box = _box(cell.polygon)
            if box:
                row_boxes[cell.row].append(box)
        self.rows = []
        for index, boxes in enumerate(row_boxes):
            bbox = (min(box[0] for box in boxes), min(box[1] for box in boxes),
                    max(box[2] for box in boxes), max(box[3] for box in boxes)) if boxes else (0, 0, 1, 1)
            self.rows.append(SimpleNamespace(cells=self.matrix[index], bbox=bbox))

    def extract(self):
        return self.matrix


class LayoutPage:
    width = 1
    height = 1

    def __init__(self, page):
        self.page = page

    def extract_text(self):
        return self.page.text

    def extract_words(self):
        words = []
        for source in self.page.words:
            box = _box(source.polygon)
            if box:
                words.append({"text": source.text, "x0": box[0], "top": box[1],
                              "x1": box[2], "bottom": box[3]})
        return words

    def find_tables(self, **_kwargs):
        return [LayoutTable(table) for table in self.page.tables]

    def search(self, pattern, **_kwargs):
        expression = re.compile(pattern)
        for line in self.page.lineEvidence:
            if expression.search(line.text):
                box = _box(line.polygon)
                if box:
                    return [{"x0": box[0], "top": box[1], "x1": box[2], "bottom": box[3]}]
        return []


def parse_layout_document(document: ExtractedDocument, tenant_scope: str | None = None):
    pages = [LayoutPage(page) for page in sorted(document.pages, key=lambda page: page.pageNumber)]
    return parse_generic_pages(pages, document.documentId, tenant_scope, document.extractorVersion)
