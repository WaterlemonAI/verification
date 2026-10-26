from pathlib import Path

import pymupdf

from bsa.visual_integrity import compare_pdf_text_to_render


SAMPLE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "bsa-synthetic-combined.pdf"


def test_rendered_text_agrees_with_synthetic_native_layer():
    result = compare_pdf_text_to_render(SAMPLE.read_bytes(), max_pages=1)
    assert result["checkedPages"] == [1]
    assert result["mismatchPages"] == []


def test_visible_statement_disagrees_with_invisible_pdf_text():
    source = pymupdf.open(SAMPLE)
    pixmap = source[0].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), alpha=False)
    altered = pymupdf.open()
    page = altered.new_page(width=source[0].rect.width, height=source[0].rect.height)
    page.insert_image(page.rect, stream=pixmap.tobytes("png"))
    page.insert_text((60, 60),
                     "INVISIBLE LEDGER ALTERED ACCOUNT OPENING CLOSING SALARY CREDIT DEBIT "
                     "DIFFERENT NUMBERS 9999.99 8888.88 7777.77", render_mode=3)
    result = compare_pdf_text_to_render(altered.tobytes())
    assert result["checkedPages"] == [1]
    assert result["mismatchPages"] == [1]
