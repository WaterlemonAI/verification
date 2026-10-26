"""Private local exports; every download remains behind the tenant API."""

import hashlib
import json
import os
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from .crypto import encrypt


def _save(path: Path, data: bytes) -> dict:
    stored = path.with_name(f"artifact.{path.name}.bin")
    temporary = path.with_name(f"{stored.name}.{uuid4().hex}.tmp")
    with open(temporary, "xb") as output:
        os.chmod(temporary, 0o600)
        output.write(encrypt(data))
    os.replace(temporary, stored)
    return {"filename": path.name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def generate(directory: Path, result: dict, *, pdf_requested: bool = False,
             xlsx_requested: bool = False) -> list[dict]:
    if result.get("status") == "failed":
        return []
    records = []
    for segment in result.get("segments", []):
        for row in segment["transactions"]:
            records.append({"statementSegmentId": segment["statementSegmentId"],
                            "transactionId": row["transactionId"], "accountId": row["accountId"],
                            "bookingDate": row["bookingDate"], "direction": row["creditDebitIndicator"],
                            "amount": row["ledgerAmount"]["value"], "currency": row["ledgerCurrency"],
                            "runningBalance": row["runningBalance"]["value"],
                            "descriptionRaw": row["descriptionRaw"], "referenceRaw": row["referenceRaw"],
                            "sourcePage": row["evidence"][0]["page"] if row.get("evidence") else None})
    ledger_bytes = json.dumps({"analysisId": result["analysisId"], "schemaVersion": result["schemaVersion"],
                               "transactions": records}, ensure_ascii=False, separators=(",", ":")).encode()
    artifacts = [{**_save(directory / "ledger.json", ledger_bytes),
                  "type": "canonical_ledger", "contentType": "application/json"}]
    import polars as pl
    columns = ["statementSegmentId", "transactionId", "accountId", "bookingDate", "direction", "amount",
               "currency", "runningBalance", "descriptionRaw", "referenceRaw", "sourcePage"]
    frame = pl.DataFrame(records, schema={column: pl.Int64 if column == "sourcePage" else pl.String for column in columns})
    parquet_buffer = BytesIO()
    frame.write_parquet(parquet_buffer)
    parquet_bytes = parquet_buffer.getvalue()
    artifacts.append({**_save(directory / "transactions.parquet", parquet_bytes),
                      "type": "transactions_parquet", "contentType": "application/vnd.apache.parquet"})
    if xlsx_requested:
        from .xlsx_report import build_xlsx
        artifacts.append({**_save(directory / "analysis.xlsx", build_xlsx(result)),
                          "type": "review_workbook",
                          "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
    if pdf_requested:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        output = BytesIO()
        pdf = canvas.Canvas(output, pagesize=A4)
        pdf.setTitle("AI7 Bank Statement Analysis - Local Audit")
        lines = ["AI7 BANK STATEMENT ANALYSIS - LOCAL AUDIT",
                 f"Analysis: {result['analysisId']}", f"Status: {result['status']}",
                 "Decision eligible: no (local demo)",
                 f"Pages: {result.get('coverage', {}).get('pageCount', 0)}",
                 f"Segments: {len(result.get('segments', []))}",
                 f"Transactions: {result.get('coverage', {}).get('transactionCount', 0)}",
                 f"Reconciled segments: {result.get('quality', {}).get('reconciledSegments', 0)}",
                 f"Reasons: {', '.join(result.get('reasonCodes', [])) or 'none'}",
                 "Statement facts and classifications require human review."]
        for index, line in enumerate(lines):
            pdf.drawString(42, A4[1] - 55 - index * 22, line[:110])
        pdf.save()
        artifacts.append({**_save(directory / "audit.pdf", output.getvalue()),
                          "type": "audit_pdf", "contentType": "application/pdf"})
    return artifacts
