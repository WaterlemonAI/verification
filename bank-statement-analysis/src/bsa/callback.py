"""Signed, SSRF-resistant terminal callbacks for bank-statement jobs."""

from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import socket
import ssl
from copy import deepcopy
from urllib.parse import SplitResult, urlsplit


EVENT_NAME = "bank_statement_analysis.completed"
SIGNATURE_HEADER = "x-ai7-signature"


class CallbackDeliveryError(RuntimeError):
    """A callback could not be delivered and may be retried safely."""


def _public_https_target(raw_url: str) -> tuple[SplitResult, str]:
    if not raw_url or len(raw_url) > 2048:
        raise ValueError("INVALID_CALLBACK_URL")
    try:
        target = urlsplit(raw_url)
        port = target.port
    except ValueError as error:
        raise ValueError("INVALID_CALLBACK_URL") from error
    if (target.scheme != "https" or not target.hostname or target.username or target.password
            or target.fragment or (port is not None and port != 443)):
        raise ValueError("INVALID_CALLBACK_URL")
    try:
        addresses = {
            item[4][0] for item in socket.getaddrinfo(target.hostname, 443, type=socket.SOCK_STREAM)
        }
    except OSError as error:
        raise CallbackDeliveryError("CALLBACK_DNS_FAILED") from error
    if not addresses:
        raise CallbackDeliveryError("CALLBACK_DNS_FAILED")
    try:
        parsed_addresses = [ipaddress.ip_address(address) for address in addresses]
    except ValueError as error:
        raise CallbackDeliveryError("CALLBACK_DNS_FAILED") from error
    if any(not address.is_global for address in parsed_addresses):
        raise ValueError("INVALID_CALLBACK_URL")
    # Container Apps currently provides reliable IPv4 egress for this worker.
    # Prefer a validated public A record when a dual-stack callback also
    # advertises AAAA; retain IPv6 as a fallback for IPv6-only endpoints.
    selected = min(parsed_addresses, key=lambda address: (address.version != 4, str(address)))
    return target, str(selected)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, address: str, timeout: float):
        super().__init__(hostname, 443, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self) -> None:
        raw_socket = socket.create_connection((self._address, self.port), self.timeout,
                                              self.source_address)
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


def callback_event(callback: dict, result: dict, completed_at: str) -> dict:
    analysis_id = str(result["analysisId"])
    api_origin = os.getenv("BSA_PUBLIC_API_ORIGIN", "https://api.ai7uae.com").rstrip("/")
    api_root = str(callback.get("apiRoot") or "/service/bank_statement_analysis").rstrip("/")
    result_url = f"{api_origin}{api_root}/{analysis_id}/result"
    data = deepcopy(result)
    data["artifacts"] = [
        {**artifact, "downloadUrl": f"{api_origin}{api_root}/{analysis_id}/artifacts/{artifact['filename']}"}
        for artifact in result.get("artifacts", [])
    ]
    return {
        "event": EVENT_NAME,
        "delivery_id": callback["deliveryId"],
        "analysis_id": analysis_id,
        "completed_at": completed_at,
        "result_url": result_url,
        "data": data,
    }


def signed_callback(callback: dict, result: dict, completed_at: str) -> tuple[bytes, dict[str, str]]:
    body = json.dumps(callback_event(callback, result, completed_at), ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    signature = hmac.new(callback["signingSecret"].encode("utf-8"), body,
                         hashlib.sha256).hexdigest()
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
        "Connection": "close",
        "User-Agent": "AI7UAE-Webhook/1.0",
        "x-ai7-event": EVENT_NAME,
        "x-ai7-delivery-id": callback["deliveryId"],
        "x-ai7-analysis-id": str(result["analysisId"]),
        SIGNATURE_HEADER: f"sha256={signature}",
    }
    return body, headers


def post_signed_callback(callback: dict, result: dict, completed_at: str) -> None:
    target, address = _public_https_target(str(callback.get("url", "")))
    body, headers = signed_callback(callback, result, completed_at)
    path = target.path or "/"
    if target.query:
        path = f"{path}?{target.query}"
    connection = _PinnedHTTPSConnection(target.hostname.encode("idna").decode("ascii"), address,
                                        timeout=float(os.getenv("BSA_CALLBACK_TIMEOUT_SECONDS", "20")))
    try:
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        response.read(1024)
        if not 200 <= response.status < 300:
            raise CallbackDeliveryError(f"CALLBACK_HTTP_{response.status}")
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise CallbackDeliveryError("CALLBACK_TRANSPORT_FAILED") from error
    finally:
        connection.close()
