"""Provider-neutral document extraction contract and deterministic local adapters."""

import io
import base64
import re
import time
from decimal import Decimal, InvalidOperation
from typing import Protocol
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, Field
from pypdf import PdfReader
import requests


class DocumentInput(BaseModel):
    documentId: str
    data: bytes
    mediaType: str = "application/pdf"


class ExtractedWord(BaseModel):
    text: str
    polygon: list[list[float]] | None = None
    confidence: float = 1.0


class ExtractedCell(BaseModel):
    row: int
    column: int
    text: str
    polygon: list[list[float]] | None = None
    confidence: float = 1.0


class ExtractedTable(BaseModel):
    cells: list[ExtractedCell] = Field(default_factory=list)
    polygon: list[list[float]] | None = None


class ExtractedPage(BaseModel):
    pageNumber: int
    text: str
    words: list[ExtractedWord] = Field(default_factory=list)
    lines: list[str] = Field(default_factory=list)
    lineEvidence: list[ExtractedWord] = Field(default_factory=list)
    tables: list[ExtractedTable] = Field(default_factory=list)
    width: float | None = None
    height: float | None = None
    warnings: list[str] = Field(default_factory=list)


class ExtractedDocument(BaseModel):
    documentId: str
    pages: list[ExtractedPage]
    extractionMethod: str
    extractorVersion: str
    modelVersion: str | None = None
    warnings: list[str] = Field(default_factory=list)


class Extractor(Protocol):
    def analyze(self, document: DocumentInput) -> ExtractedDocument: ...


class NativePdfExtractor:
    version = "pypdf-native-v1"

    def analyze(self, document: DocumentInput) -> ExtractedDocument:
        if document.mediaType != "application/pdf":
            raise ValueError("UNSUPPORTED_FILE_TYPE")
        reader = PdfReader(io.BytesIO(document.data), strict=True)
        if reader.is_encrypted:
            raise ValueError("PASSWORD_PROTECTED_PDF")
        if len(reader.pages) > 100:
            raise ValueError("PAGE_LIMIT_EXCEEDED")
        root = reader.trailer.get("/Root", {})
        if any(key in root for key in ("/OpenAction", "/AA")):
            raise ValueError("ACTIVE_PDF_CONTENT_NOT_ALLOWED")
        names = root.get("/Names", {}) if hasattr(root, "get") else {}
        if hasattr(names, "get") and any(key in names for key in ("/JavaScript", "/EmbeddedFiles")):
            raise ValueError("ACTIVE_PDF_CONTENT_NOT_ALLOWED")
        pages = []
        import pdfplumber
        layout = pdfplumber.open(io.BytesIO(document.data))
        for number, page in enumerate(reader.pages, 1):
            text = page.extract_text(extraction_mode="plain") or ""
            if len(text) > 2_000_000:
                raise ValueError("PAGE_TEXT_LIMIT_EXCEEDED")
            width, height = float(page.mediabox.width), float(page.mediabox.height)
            source = layout.pages[number - 1]
            def polygon(item):
                return [[round(item["x0"] / width, 4), round(item["top"] / height, 4)],
                        [round(item["x1"] / width, 4), round(item["top"] / height, 4)],
                        [round(item["x1"] / width, 4), round(item["bottom"] / height, 4)],
                        [round(item["x0"] / width, 4), round(item["bottom"] / height, 4)]]
            words = [ExtractedWord(text=item["text"], polygon=polygon(item)) for item in source.extract_words()]
            source_lines = source.extract_text_lines(return_chars=False)
            line_evidence = [ExtractedWord(text=item["text"], polygon=polygon(item)) for item in source_lines]
            pages.append(ExtractedPage(pageNumber=number, text=text,
                                       lines=[line for line in text.splitlines() if line.strip()],
                                       lineEvidence=line_evidence, words=words,
                                       width=width, height=height,
                                       warnings=[] if text.strip() else ["NATIVE_TEXT_ABSENT"]))
        return ExtractedDocument(documentId=document.documentId, pages=pages,
                                 extractionMethod="native_pdf", extractorVersion=self.version)


class ManagedLayoutFixtureExtractor:
    """Deterministic stand-in for an approved managed Layout provider.

    The provider payload is already translated to the same neutral schema;
    there is intentionally no network request in local development.
    """

    version = "managed-layout-fixture-v1"

    def __init__(self, response: dict):
        self.response = response

    def analyze(self, document: DocumentInput) -> ExtractedDocument:
        result = ExtractedDocument.model_validate(self.response)
        if result.documentId != document.documentId:
            raise ValueError("EXTRACTION_DOCUMENT_MISMATCH")
        return result


class AzureLayoutExtractor:
    """v4 prebuilt-layout adapter. No network access without explicit policy gates."""

    api_version = "2024-11-30"
    model_id = "prebuilt-layout"
    version = "azure-layout-v4-2024-11-30"

    def __init__(self, *, endpoint: str | None = None, api_key: str | None = None,
                 resource_region: str | None = None, approved_region: str | None = None,
                 approved: bool = False, max_pages: int | None = None,
                 max_cost_usd: str | None = None, estimated_page_cost_usd: str | None = None,
                 session=None, poll_interval: float = 0.5, max_polls: int = 60):
        self.endpoint = (endpoint or "").rstrip("/")
        self.api_key = api_key or ""
        self.resource_region = resource_region or ""
        self.approved_region = approved_region or ""
        self.approved = approved
        self.max_pages = max_pages
        self.max_cost_usd = max_cost_usd
        self.estimated_page_cost_usd = estimated_page_cost_usd
        self.session = session or requests.Session()
        self.poll_interval = poll_interval
        self.max_polls = max_polls

    def _gate(self, document: DocumentInput) -> None:
        if not self.approved or not self.approved_region or self.resource_region != self.approved_region:
            raise ValueError("MANAGED_EXTRACTION_NOT_APPROVED")
        if not self.api_key or not self.max_pages or self.max_pages < 1:
            raise ValueError("MANAGED_EXTRACTION_NOT_CONFIGURED")
        try:
            ceiling = Decimal(self.max_cost_usd or "")
            page_cost = Decimal(self.estimated_page_cost_usd or "")
        except InvalidOperation as error:
            raise ValueError("MANAGED_EXTRACTION_COST_POLICY_MISSING") from error
        if not ceiling.is_finite() or not page_cost.is_finite() or ceiling <= 0 or page_cost <= 0:
            raise ValueError("MANAGED_EXTRACTION_COST_POLICY_MISSING")
        parsed = urlparse(self.endpoint)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
            raise ValueError("MANAGED_EXTRACTION_ENDPOINT_INVALID")
        if not (parsed.hostname.endswith(".cognitiveservices.azure.com") or
                parsed.hostname.endswith(".api.cognitive.microsoft.com")):
            raise ValueError("MANAGED_EXTRACTION_ENDPOINT_INVALID")
        if document.mediaType != "application/pdf":
            raise ValueError("UNSUPPORTED_FILE_TYPE")
        reader = PdfReader(io.BytesIO(document.data), strict=True)
        if reader.is_encrypted or len(reader.pages) > self.max_pages:
            raise ValueError("MANAGED_EXTRACTION_PAGE_LIMIT")
        if len(reader.pages) * page_cost > ceiling:
            raise ValueError("MANAGED_EXTRACTION_COST_LIMIT")

    def _result_url(self, operation_location: str) -> str:
        expected = urlparse(self.endpoint)
        actual = urlparse(operation_location)
        pattern = rf"/documentintelligence/documentModels/{self.model_id}/analyzeResults/([0-9a-fA-F-]{{36}})"
        match = re.fullmatch(pattern, actual.path)
        if (actual.scheme != "https" or actual.netloc != expected.netloc or not match
                or actual.query != f"api-version={self.api_version}" or actual.fragment):
            raise ValueError("MANAGED_EXTRACTION_RESULT_URL_INVALID")
        try:
            UUID(match.group(1))
        except ValueError as error:
            raise ValueError("MANAGED_EXTRACTION_RESULT_URL_INVALID") from error
        return operation_location

    @staticmethod
    def _polygon(raw: list | None, width: float, height: float) -> list[list[float]] | None:
        if not raw or len(raw) != 8 or width <= 0 or height <= 0:
            return None
        return [[round(float(raw[index]) / width, 4), round(float(raw[index + 1]) / height, 4)]
                for index in range(0, 8, 2)]

    def _translate(self, document_id: str, payload: dict) -> ExtractedDocument:
        result = payload.get("analyzeResult") or {}
        if result.get("modelId") not in {None, self.model_id}:
            raise ValueError("MANAGED_EXTRACTION_MODEL_MISMATCH")
        pages = []
        by_number = {}
        for source in result.get("pages", []):
            number = int(source["pageNumber"])
            width, height = float(source["width"]), float(source["height"])
            if width <= 0 or height <= 0 or number in by_number:
                raise ValueError("MANAGED_EXTRACTION_INVALID_RESULT")
            words = [ExtractedWord(text=str(item.get("content", "")),
                                   polygon=self._polygon(item.get("polygon"), width, height),
                                   confidence=float(item.get("confidence", 1.0)))
                     for item in source.get("words", [])]
            line_evidence = [ExtractedWord(text=str(item.get("content", "")),
                                           polygon=self._polygon(item.get("polygon"), width, height))
                             for item in source.get("lines", [])]
            lines = [item.text for item in line_evidence if item.text.strip()]
            page = ExtractedPage(pageNumber=number, text="\n".join(lines), words=words,
                                 lines=lines, lineEvidence=line_evidence,
                                 width=width, height=height)
            pages.append(page)
            by_number[number] = page
        if not pages:
            raise ValueError("MANAGED_EXTRACTION_INVALID_RESULT")
        for table in result.get("tables", []):
            cells_by_page = {}
            for item in table.get("cells", []):
                for region in item.get("boundingRegions", []):
                    number = int(region["pageNumber"])
                    page = by_number.get(number)
                    if not page:
                        continue
                    cell = ExtractedCell(row=int(item["rowIndex"]), column=int(item["columnIndex"]),
                                         text=str(item.get("content", "")),
                                         polygon=self._polygon(region.get("polygon"), page.width, page.height),
                                         confidence=float(item.get("confidence", 1.0)))
                    cells_by_page.setdefault(number, []).append(cell)
            for number, cells in cells_by_page.items():
                by_number[number].tables.append(ExtractedTable(cells=cells))
        return ExtractedDocument(documentId=document_id, pages=sorted(pages, key=lambda item: item.pageNumber),
                                 extractionMethod="azure_document_intelligence_layout",
                                 extractorVersion=self.version,
                                 modelVersion=f"{self.model_id}:{self.api_version}")

    def analyze(self, document: DocumentInput) -> ExtractedDocument:
        self._gate(document)
        analyze_url = (f"{self.endpoint}/documentintelligence/documentModels/{self.model_id}:analyze"
                       f"?_overload=analyzeDocument&api-version={self.api_version}")
        headers = {"Ocp-Apim-Subscription-Key": self.api_key, "Content-Type": "application/json"}
        operation_url = None
        deletion_failed = False
        try:
            response = self.session.post(analyze_url, headers=headers,
                                         json={"base64Source": base64.b64encode(document.data).decode("ascii")}, timeout=30)
            if response.status_code != 202:
                raise ValueError("MANAGED_EXTRACTION_SUBMIT_FAILED")
            operation_url = self._result_url(response.headers.get("Operation-Location", ""))
            for _ in range(self.max_polls):
                response = self.session.get(operation_url, headers=headers, timeout=30)
                if response.status_code != 200:
                    raise ValueError("MANAGED_EXTRACTION_POLL_FAILED")
                payload = response.json()
                status = str(payload.get("status", "")).casefold()
                if status == "succeeded":
                    return self._translate(document.documentId, payload)
                if status in {"failed", "canceled"}:
                    raise ValueError("MANAGED_EXTRACTION_FAILED")
                if status not in {"running", "notstarted"}:
                    raise ValueError("MANAGED_EXTRACTION_INVALID_RESULT")
                time.sleep(self.poll_interval)
            raise ValueError("MANAGED_EXTRACTION_TIMEOUT")
        except requests.RequestException as error:
            raise ValueError("MANAGED_EXTRACTION_UNAVAILABLE") from error
        finally:
            if operation_url:
                try:
                    response = self.session.delete(operation_url, headers=headers, timeout=30)
                    deletion_failed = response.status_code != 204
                except requests.RequestException:
                    deletion_failed = True
                if deletion_failed:
                    raise ValueError("MANAGED_EXTRACTION_DELETE_FAILED")
