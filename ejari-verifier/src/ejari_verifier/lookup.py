#!/usr/bin/env python3
"""Look up Ejari by numbers or PDF, then OCR and verify the DLD certificate.

OpenAI OCR defaults to gpt-5-nano, the lowest priced available vision model
as of October 2026. The DLD browser lookup uses Google Chrome.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import getpass
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from .ocr import OCRError, compare_claims, ocr_pdf, parse_dld_pdf
from .malware import scan_inputs

DLD_URL = "https://dubailand.gov.ae/en/eservices/download-ejari-certificate/"
DLD_ENDPOINT = "https://dubailand.gov.ae/umbraco/surface/CaptchaProxy/DownloadEjariCertificate"
OCR_SOURCE = Path(__file__).with_name("ejari-ocr.swift")
OCR_BINARY = Path.home() / "Library/Caches/ejari-verifier/ejari-ocr"
CONTRACT_RE = re.compile(r"\b0\d{14,16}\b")
PREMISE_RE = re.compile(r"\b\d{8,11}\b")
DM_RE = re.compile(r"\b(\d{1,5})\s*[-/]\s*(\d{1,5})\b")


class EjariError(Exception):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ocr_binary() -> Path:
    if sys.platform != "darwin":
        raise EjariError("Apple Vision OCR requires macOS. Use the default OpenAI OCR engine on another OS.")
    if not OCR_BINARY.exists() or OCR_BINARY.stat().st_mtime < OCR_SOURCE.stat().st_mtime:
        OCR_BINARY.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["swiftc", str(OCR_SOURCE), "-o", str(OCR_BINARY)],
            text=True, capture_output=True, check=False,
        )
        if result.returncode:
            raise EjariError(f"Could not compile macOS OCR helper: {result.stderr[-400:]}")
    return OCR_BINARY


def nearby(lines: list[str], label: str, pattern: re.Pattern[str], after: int = 8):
    for index, line in enumerate(lines):
        if re.search(label, line, re.IGNORECASE):
            match = pattern.search("\n".join(lines[index:index + after]))
            if match:
                return match.groups() if match.groups() else match.group()
    return None


def extract(pdf: Path | None, args: argparse.Namespace) -> dict:
    if pdf is None:
        return {
            "contract_number": args.contract_number,
            "dewa_number": args.dewa_number,
            "municipality": None,
            "sub_number": None,
        }
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        raise EjariError(f"PDF not found: {pdf}")
    if args.contract_number and (args.dewa_number or args.municipality):
        fields = {}
    elif args.ocr_engine == "openai":
        try:
            fields, usage = ocr_pdf(
                pdf, args.openai_key, args.ocr_model, args.ocr_detail, args.ocr_page
            )
        except OCRError as exc:
            raise EjariError(str(exc)) from exc
        fields["ocr_usage"] = usage
    else:
        result = subprocess.run([str(ocr_binary()), str(pdf)], text=True, capture_output=True, check=False)
        if result.returncode:
            raise EjariError(f"Could not read {pdf.name}: {result.stderr[-400:]}")
        text = result.stdout.split("=== PAGE 2 ===")[0]
        lines = text.splitlines()
        dm = nearby(lines, r"Land\s*DM\s*No", DM_RE, 5)
        fields = {
            "contract_number": nearby(lines, r"Contract\s*No", CONTRACT_RE, 5),
            "dewa_number": nearby(lines, r"DEWA\s*Premise\s*No", PREMISE_RE, 8),
            "municipality": dm[0] if isinstance(dm, tuple) else None,
            "sub_number": dm[1] if isinstance(dm, tuple) else None,
            "ocr_usage": {"engine": "macOS Vision"},
        }
    contract = args.contract_number or fields.get("contract_number")
    dewa = args.dewa_number or fields.get("dewa_number")
    municipality = args.municipality or fields.get("municipality")
    sub_number = args.sub_number or fields.get("sub_number")
    if not contract or not re.fullmatch(r"\d{14,17}", str(contract)):
        raise EjariError("Could not read the Ejari contract number. Supply --contract-number.")
    if not dewa and not (municipality and sub_number):
        raise EjariError("Could not read a DEWA or municipality number. Supply --dewa-number or --municipality and --sub-number.")
    fields.update({
        "contract_number": str(contract),
        "dewa_number": str(dewa) if dewa else None,
        "municipality": str(municipality) if municipality else None,
        "sub_number": str(sub_number) if sub_number else None,
    })
    return fields


def capsolver_post(endpoint: str, payload: dict) -> dict:
    response = requests.post(f"https://api.capsolver.com/{endpoint}", json=payload, timeout=35)
    response.raise_for_status()
    return response.json()


def capsolver_v3(api_key: str, site_key: str) -> dict:
    created = capsolver_post("createTask", {
        "clientKey": api_key,
        "task": {
            "type": "ReCaptchaV3M1TaskProxyLess",
            "websiteURL": DLD_URL,
            "websiteKey": site_key,
            "pageAction": "submit",
        },
    })
    if created.get("errorId") or not created.get("taskId"):
        raise EjariError(f"CapSolver rejected task: {created.get('errorDescription', 'unknown error')}")
    task_id = created["taskId"]
    for _ in range(40):
        time.sleep(3)
        result = capsolver_post("getTaskResult", {"clientKey": api_key, "taskId": task_id})
        if result.get("errorId") or result.get("status") == "failed":
            raise EjariError(f"CapSolver failed: {result.get('errorDescription', 'unknown error')}")
        if result.get("status") == "ready":
            solution = result.get("solution", {})
            token = solution.get("gRecaptchaResponse")
            if not token:
                raise EjariError("CapSolver returned no reCAPTCHA token.")
            return solution
    raise EjariError("CapSolver did not return a token before timeout.")


def dld_config(session: requests.Session) -> tuple[bool, str | None]:
    response = session.get(DLD_URL, timeout=35)
    response.raise_for_status()
    enabled = re.search(r'"captchaEnabled"\s*:\s*(true|false)', response.text, re.I)
    site_key = re.search(r'"recaptchaSiteKeyV3"\s*:\s*"([^"]+)"', response.text)
    if not enabled:
        raise EjariError("DLD CAPTCHA configuration was not found; the page may have changed.")
    if enabled.group(1).lower() == "true" and not site_key:
        raise EjariError("DLD reCAPTCHA v3 site key was not found; the page may have changed.")
    return enabled.group(1).lower() == "true", site_key.group(1) if site_key else None


def parse_dld_response(body: str) -> bytes | None:
    body = body.strip().strip('"')
    if body == "Invalid Captcha":
        raise EjariError("DLD rejected the reCAPTCHA token. No record status can be inferred.")
    if body == "bnVsbA==":
        return None
    try:
        data = base64.b64decode(body, validate=True)
    except binascii.Error as exc:
        raise EjariError(f"Unexpected DLD response: {body[:100]!r}") from exc
    if not data.startswith(b"%PDF-"):
        raise EjariError("DLD returned data, but it was not a PDF.")
    return data


def query_dld(session: requests.Session, fields: dict, method: str, solution: dict) -> bytes | None:
    contract = fields["contract_number"]
    if method == "DEWA":
        params = f"&ContractNumber={contract}&DewaNumber={fields['dewa_number']}&MunicipalityNumber=&MunicipalitySubNumber="
    else:
        params = (f"&ContractNumber={contract}&MunicipalityNumber={fields['municipality']}"
                  f"&MunicipalitySubNumber={fields['sub_number']}&DewaNumber=")
    headers = {"Origin": "https://dubailand.gov.ae", "Referer": DLD_URL}
    if solution.get("userAgent"):
        headers["User-Agent"] = solution["userAgent"]
    if solution.get("secChUa"):
        headers["sec-ch-ua"] = solution["secChUa"]
    response = session.post(
        DLD_ENDPOINT,
        json={"Url": params, "Captcha": solution.get("gRecaptchaResponse", ""), "ServiceType": "EjariDownloadCertificate"},
        headers=headers,
        timeout=45,
    )
    response.raise_for_status()
    return parse_dld_response(response.text)


def save_and_compare(pdf: Path | None, fields: dict, args: argparse.Namespace, data: bytes, result: dict) -> None:
    safe_stem = re.sub(r"[^A-Za-z0-9_-]+", "-", pdf.stem) if pdf else "numbers"
    destination = args.output_dir / f"ejari-{fields['contract_number']}-{safe_stem}.pdf"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if len(data) > 20 * 1024 * 1024:
        raise EjariError("DLD certificate exceeded the size limit.")
    scan_inputs([("application/pdf", data)])
    destination.write_bytes(data)
    result.update(status="downloaded", downloaded_file=str(destination))
    try:
        official, usage = ocr_pdf(destination, args.openai_key, args.ocr_model, args.ocr_detail)
        result["retrieved_ocr"] = official
        result["retrieved_ocr_usage"] = usage
        ocr_file = destination.with_suffix(".ocr.json")
        ocr_record = {
            "schema_version": 1,
            "source_pdf": str(destination),
            "ocr_usage": usage,
            "fields": official,
        }
        ocr_file.write_text(json.dumps(ocr_record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        result["retrieved_ocr_file"] = str(ocr_file)
        result["verification"] = compare_claims(fields, official)
        try:
            text_fields = parse_dld_pdf(destination)
            result["retrieved_ocr_check"] = compare_claims(official, text_fields)
        except OCRError as exc:
            result["retrieved_ocr_check"] = {"status": "unavailable", "error": str(exc)}
    except OCRError as exc:
        result["status"] = "downloaded; OCR failed"
        result["retrieved_ocr_error"] = str(exc)


def verify_one(pdf: Path | None, args: argparse.Namespace, session: requests.Session, api_key: str) -> dict:
    result = {"input_type": "pdf" if pdf else "numbers", "checked_at_utc": utc_now(), "source_url": DLD_URL}
    if pdf:
        result["input_pdf"] = str(pdf)
    try:
        fields = extract(pdf, args)
        result.update(fields)
        if args.dry_run:
            result["status"] = "extracted only"
            return result
        if args.dewa_only and not fields["dewa_number"]:
            raise EjariError("--dewa-only was selected, but no DEWA premise number was found.")
        enabled, site_key = dld_config(session)
        if enabled and not api_key:
            result["status"] = "captcha key required"
            result["message"] = "Set CAPSOLVER_API_KEY before running the live lookup."
            return result
        methods = [name for name, available in (
            ("DEWA", fields["dewa_number"]),
            ("municipality", not args.dewa_only and fields["municipality"] and fields["sub_number"]),
        ) if available]
        result["methods_attempted"] = []
        for method in methods:
            # reCAPTCHA tokens are short-lived and single-use. Solve only when
            # this method is about to be submitted; never reuse a token.
            solution = capsolver_v3(api_key, site_key) if enabled else {}
            data = query_dld(session, fields, method, solution)
            status = "downloaded" if data else "no record found"
            result["methods_attempted"].append({"method": method, "status": status})
            if data:
                save_and_compare(pdf, fields, args, data, result)
                return result
        result["status"] = "no record found (DEWA only)" if args.dewa_only else "no record found"
        return result
    except Exception as exc:
        # Error text never contains the key or token.
        result["status"] = "error"
        result["error"] = str(exc) if isinstance(exc, EjariError) else type(exc).__name__
        return result


async def query_dld_in_browser(context, fields: dict, method: str) -> bytes | None:
    for attempt in range(2):
        page = await context.new_page()
        try:
            await page.goto(DLD_URL + "#/", wait_until="load", timeout=60_000)
            await page.locator("#contractNumber").wait_for(timeout=30_000)
            if await page.evaluate("() => window.AppInfo?.featureGate?.captchaEnabled === true"):
                await asyncio.wait_for(
                    page.evaluate("() => new Promise(resolve => grecaptcha.ready(resolve))"),
                    timeout=30,
                )
            await page.locator("#contractNumber").fill(fields["contract_number"])
            if await page.locator("#contractNumber").input_value() != fields["contract_number"]:
                raise EjariError("The DLD form changed the contract number during entry.")
            if method == "DEWA":
                await page.locator("#dewaOption").check()
                await page.locator("#dewaNumber").fill(fields["dewa_number"])
            else:
                await page.locator("#dmOption").check()
                await page.locator("#dmNumber").fill(fields["municipality"])
                await page.locator("#dmSubNumber").fill(fields["sub_number"])
            async with page.expect_response(
                lambda response: response.url.startswith(DLD_ENDPOINT), timeout=45_000
            ) as response_info:
                await page.get_by_role("button", name="Download file").click()
            response = await response_info.value
            if response.status != 200:
                raise EjariError(f"DLD returned HTTP {response.status}.")
            try:
                return parse_dld_response(await response.text())
            except EjariError as exc:
                if "reCAPTCHA token" not in str(exc) or attempt == 1:
                    raise
        finally:
            await page.close()
    raise EjariError("DLD rejected two browser reCAPTCHA tokens.")


async def verify_one_browser(context, pdf: Path | None, args: argparse.Namespace) -> dict:
    result = {"input_type": "pdf" if pdf else "numbers", "checked_at_utc": utc_now(), "source_url": DLD_URL}
    if pdf:
        result["input_pdf"] = str(pdf)
    try:
        fields = extract(pdf, args)
        result.update(fields)
        if args.dewa_only and not fields["dewa_number"]:
            raise EjariError("--dewa-only was selected, but no DEWA premise number was found.")
        methods = [name for name, available in (
            ("DEWA", fields["dewa_number"]),
            ("municipality", not args.dewa_only and fields["municipality"] and fields["sub_number"]),
        ) if available]
        result["methods_attempted"] = []
        for method in methods:
            data = await query_dld_in_browser(context, fields, method)
            status = "downloaded" if data else "no record found"
            result["methods_attempted"].append({"method": method, "status": status})
            if data:
                save_and_compare(pdf, fields, args, data, result)
                return result
        result["status"] = "no record found (DEWA only)" if args.dewa_only else "no record found"
        return result
    except Exception as exc:
        result["status"] = "error"
        result["error"] = str(exc) if isinstance(exc, EjariError) else type(exc).__name__
        return result


async def run_browser(args: argparse.Namespace) -> list[dict]:
    from playwright.async_api import async_playwright
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            channel="chrome", headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            context = await browser.new_context(accept_downloads=True)
            return [await verify_one_browser(context, pdf.resolve() if pdf else None, args)
                    for pdf in (args.pdfs or [None])]
        finally:
            await browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdfs", type=Path, nargs="*", help="One or more Ejari PDF files; omit when providing both lookup numbers")
    parser.add_argument("--output-dir", type=Path, default=Path("output/ejari-downloads"))
    parser.add_argument("--dry-run", action="store_true", help="Skip DLD lookup; PDF source OCR still uses API tokens")
    parser.add_argument("--ocr-engine", choices=("openai", "vision"), default="openai", help="Input PDF OCR engine; downloaded PDF always uses OpenAI (default: openai)")
    parser.add_argument("--ocr-model", default="gpt-5-nano", help="OpenAI vision model (default: gpt-5-nano)")
    parser.add_argument("--ocr-detail", choices=("low", "high", "original", "auto"), default="high")
    parser.add_argument("--ocr-page", type=int, default=1, help="Certificate page to send for OCR (default: 1)")
    parser.add_argument("--browser", action="store_true", help="Use Chrome and DLD's own reCAPTCHA flow (the default)")
    parser.add_argument("--capsolver", action="store_true", help="Use paid CapSolver v3 M1 tasks instead of Chrome")
    parser.add_argument("--dewa-only", action="store_true", help="Check only DEWA; skip municipality fallback")
    parser.add_argument("--ejari-number", "--contract-number", dest="contract_number", help="Ejari contract number; with --dewa-number, allows lookup without an input PDF")
    parser.add_argument("--dewa-number", help="DEWA premise number; with --ejari-number, allows lookup without an input PDF")
    parser.add_argument("--municipality", help="Override OCR for one PDF")
    parser.add_argument("--sub-number", help="Override OCR for one PDF")
    args = parser.parse_args()
    if not args.pdfs and not (args.contract_number and args.dewa_number):
        parser.error("Provide an Ejari PDF, or both --ejari-number and --dewa-number")
    if not args.pdfs and (args.municipality or args.sub_number):
        parser.error("A numbers-only lookup uses --ejari-number and --dewa-number")
    if len(args.pdfs) > 1 and any((args.contract_number, args.dewa_number, args.municipality, args.sub_number)):
        parser.error("Manual number overrides can only be used with one PDF")
    if args.contract_number and not re.fullmatch(r"\d{14,17}", args.contract_number):
        parser.error("--ejari-number must contain 14 to 17 digits")
    if args.dewa_number and not re.fullmatch(r"\d{8,11}", args.dewa_number):
        parser.error("--dewa-number must contain 8 to 11 digits")
    if bool(args.municipality) != bool(args.sub_number):
        parser.error("Use --municipality and --sub-number together")
    if args.browser and args.capsolver:
        parser.error("Choose either --browser or --capsolver")
    if args.ocr_page < 1:
        parser.error("--ocr-page must be at least 1")
    args.output_dir = args.output_dir.resolve()
    args.openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    needs_source_ocr = bool(args.pdfs) and not (args.contract_number and (args.dewa_number or args.municipality))
    needs_openai = not args.dry_run or (args.ocr_engine == "openai" and needs_source_ocr)
    if needs_openai and not args.openai_key and sys.stdin.isatty():
        args.openai_key = getpass.getpass("OpenAI API key: ").strip()
    if needs_openai and not args.openai_key:
        parser.error("Set OPENAI_API_KEY or run interactively to enter it")
    api_key = os.environ.get("CAPSOLVER_API_KEY", "").strip()
    if not api_key and not args.dry_run and args.capsolver and sys.stdin.isatty():
        api_key = getpass.getpass("CapSolver API key (Enter to skip live lookup): ").strip()
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
        "Accept": "*/*",
    })
    if not args.capsolver and not args.dry_run:
        try:
            results = asyncio.run(run_browser(args))
        except Exception as exc:
            print(f"Could not launch Chrome: {type(exc).__name__}", file=sys.stderr)
            return 2
    else:
        results = [verify_one(pdf.resolve() if pdf else None, args, session, api_key)
                   for pdf in (args.pdfs or [None])]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary = args.output_dir / f"results-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json"
    summary.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for item in results:
        label = Path(item["input_pdf"]).name if item.get("input_pdf") else f"Ejari {item.get('contract_number', '-')}"
        print(f"{label}: {item['status']}")
        if item.get("contract_number"):
            print(f"  Contract {item['contract_number']}; DEWA {item.get('dewa_number') or '-'}; municipality {item.get('municipality') or '-'} / {item.get('sub_number') or '-'}")
        if item.get("ocr_usage"):
            print(f"  OCR: {item['ocr_usage'].get('model') or item['ocr_usage'].get('engine')}")
        if item.get("downloaded_file"):
            print(f"  Downloaded PDF: {item['downloaded_file']}")
            if item.get("retrieved_ocr_file"):
                print(f"  Retrieved OCR JSON: {item['retrieved_ocr_file']}")
            for name, value in item.get("retrieved_ocr", {}).items():
                if value is not None:
                    print(f"    {name}: {value}")
            verification = item.get("verification", {})
            compared = verification.get("compared_fields")
            count = f" ({compared} fields compared)" if compared is not None else ""
            print(f"  Comparison: {verification.get('status', 'unavailable')}{count}")
            if verification.get("different_fields"):
                print(f"  Different fields: {', '.join(verification['different_fields'])}")
            ocr_check = item.get("retrieved_ocr_check", {})
            if ocr_check.get("different_fields"):
                print(f"  Retrieved OCR differs from PDF text in: {', '.join(ocr_check['different_fields'])}")
            if item.get("retrieved_ocr_error"):
                print(f"  Retrieved OCR error: {item['retrieved_ocr_error']}")
        elif item.get("error") or item.get("message"):
            print(f"  {item.get('error') or item.get('message')}")
    print(f"Results: {summary}")
    return 1 if any(item["status"] in {"error", "downloaded; OCR failed"} for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
