"""One isolated parser process per job; output is written privately, never to stdout."""

import json
import os
import sys
from uuid import uuid4
from pathlib import Path

from .engine import analyze
from .inputs import normalize_inputs
from .artifacts import generate
from .crypto import decrypt, encrypt
from .malware import scan_inputs
from .visual_integrity import compare_pdf_text_to_render
from .credit_assessment import assess


def configured_layout_extractor():
    if os.getenv("BSA_MANAGED_EXTRACTION_APPROVED") != "1":
        return None
    from .extraction import AzureLayoutExtractor
    try:
        max_pages = int(os.getenv("BSA_MANAGED_MAX_PAGES", "0"))
    except ValueError:
        max_pages = 0
    return AzureLayoutExtractor(
        endpoint=os.getenv("BSA_AZURE_LAYOUT_ENDPOINT"),
        api_key=os.getenv("BSA_AZURE_LAYOUT_KEY"),
        resource_region=os.getenv("BSA_AZURE_LAYOUT_REGION"),
        approved_region=os.getenv("BSA_APPROVED_PROCESSING_REGION"),
        approved=True, max_pages=max_pages,
        max_cost_usd=os.getenv("BSA_MANAGED_MAX_COST_USD"),
        estimated_page_cost_usd=os.getenv("BSA_MANAGED_ESTIMATED_PAGE_COST_USD"),
    )


def run(directory: Path) -> None:
    job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
    inputs = json.loads((directory / "inputs.json").read_text(encoding="utf-8"))
    files = [(item["mediaType"], decrypt((directory / f"input-{item['index']}.bin").read_bytes())) for item in inputs]
    fields = json.loads(decrypt((directory / "fields.bin").read_bytes()))
    malware_gate = "not_configured_local_demo"
    try:
        malware_gate = scan_inputs(files)
        document = normalize_inputs(files)
    except ValueError as error:
        if str(error) in {"MALWARE_CHECK_FAILED", "MALWARE_DETECTED"}:
            malware_gate = "failed"
        result = {"analysisId": job["id"], "status": "failed", "decisionEligible": False,
                  "reasonCodes": [str(error)], "segments": [], "features": {}, "schemaVersion": "bsa-v1.0.0"}
    else:
        try:
            visual_check = compare_pdf_text_to_render(document)
        except Exception:
            from pypdf import PdfReader
            import io
            try:
                pages = len(PdfReader(io.BytesIO(document)).pages)
            except Exception:
                pages = 0
            visual_check = {"methodVersion": "rendered-native-comparison-v1", "checkedPages": [],
                            "inconclusivePages": list(range(1, pages + 1)), "mismatchPages": []}
        untrusted = set(visual_check["mismatchPages"]) | set(visual_check["inconclusivePages"])
        result = analyze(document, job["id"], fields, job.get("ownerId"),
                         configured_layout_extractor(), untrusted)
        result.setdefault("quality", {})["visualTextCheck"] = visual_check
        if visual_check["mismatchPages"]:
            result.setdefault("reasonCodes", []).append("VISUAL_TEXT_LAYER_MISMATCH")
            result["status"] = "partial"
            result["decisionEligible"] = False
        if visual_check["inconclusivePages"]:
            result.setdefault("reasonCodes", []).append("VISUAL_TEXT_CHECK_INCOMPLETE")
            result["status"] = "partial"
            result["decisionEligible"] = False
        if untrusted:
            result["reasonCodes"] = sorted(set(result["reasonCodes"]))
            result.setdefault("analysis", {})["status"] = "partial"
            result.setdefault("findings", []).extend(
                {"reasonCode": code, "classification": "review_signal"}
                for code in result["reasonCodes"] if code in
                {"VISUAL_TEXT_LAYER_MISMATCH", "VISUAL_TEXT_CHECK_INCOMPLETE"})
    result.setdefault("quality", {})["malwareGate"] = malware_gate
    if malware_gate == "not_configured_local_demo":
        result.setdefault("limitations", []).append("Malware scanning was not configured in this local demo.")
    result["creditAssessment"] = assess(result, fields.get("creditModels", []))
    result["artifacts"] = generate(directory, result, pdf_requested=fields.get("getPdf", False),
                                   xlsx_requested=fields.get("getXlsx", False))
    temporary = directory / f"result.{uuid4().hex}.tmp"
    with open(temporary, "xb") as output:
        os.chmod(temporary, 0o600)
        output.write(encrypt(json.dumps(result, ensure_ascii=False).encode()))
    os.replace(temporary, directory / "result.bin")


if __name__ == "__main__":
    run(Path(sys.argv[1]))
