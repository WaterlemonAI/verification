import hashlib
import hmac
import json

import pytest

from bsa import callback as callback_module
from bsa import azure_worker
from bsa.callback import CallbackDeliveryError, callback_event, signed_callback
from bsa.crypto import encrypt


def test_signed_callback_preserves_terminal_result_and_artifact_links(monkeypatch):
    monkeypatch.setenv("BSA_PUBLIC_API_ORIGIN", "https://api.ai7uae.com")
    callback = {
        "url": "https://hooks.example.test/ai7",
        "signingSecret": "secret-value",
        "deliveryId": "delivery-1",
        "apiRoot": "/service/bank_statement_analysis",
    }
    result = {
        "analysisId": "bsa_00000000-0000-0000-0000-000000000001",
        "status": "partial",
        "decisionEligible": False,
        "reasonCodes": ["REVIEW_REQUIRED"],
        "artifacts": [{"filename": "audit.pdf", "contentType": "application/pdf"}],
    }
    event = callback_event(callback, result, "2026-10-26T12:00:00+00:00")
    assert event["data"]["status"] == "partial"
    assert event["data"]["decisionEligible"] is False
    assert event["data"]["artifacts"][0]["downloadUrl"].endswith(
        "/service/bank_statement_analysis/bsa_00000000-0000-0000-0000-000000000001/artifacts/audit.pdf")
    body, headers = signed_callback(callback, result, event["completed_at"])
    expected = hmac.new(b"secret-value", body, hashlib.sha256).hexdigest()
    assert headers["x-ai7-signature"] == f"sha256={expected}"
    assert json.loads(body)["delivery_id"] == "delivery-1"


def test_callback_target_rejects_non_https_credentials_and_private_dns(monkeypatch):
    monkeypatch.setattr(callback_module.socket, "getaddrinfo",
                        lambda *_args, **_kwargs: [(2, 1, 6, "", ("10.0.0.8", 443))])
    with pytest.raises(ValueError, match="INVALID_CALLBACK_URL"):
        callback_module._public_https_target("http://example.com/hook")
    with pytest.raises(ValueError, match="INVALID_CALLBACK_URL"):
        callback_module._public_https_target("https://user:pass@example.com/hook")
    with pytest.raises(ValueError, match="INVALID_CALLBACK_URL"):
        callback_module._public_https_target("https://example.com/hook")


def test_callback_target_prefers_public_ipv4_for_dual_stack_azure_egress(monkeypatch):
    monkeypatch.setattr(callback_module.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (10, 1, 6, "", ("2606:4700::6810:85e5", 443, 0, 0)),
        (2, 1, 6, "", ("104.16.133.229", 443)),
    ])
    _target, address = callback_module._public_https_target("https://webhook.example/hook")
    assert address == "104.16.133.229"


class _Download:
    def __init__(self, value):
        self.value = value

    def readall(self):
        return self.value


class _Container:
    def __init__(self, blobs):
        self.blobs = blobs

    def download_blob(self, name):
        return _Download(self.blobs[name])


class _Table:
    def __init__(self, entity):
        self.entity = entity

    def get_entity(self, _partition, _row):
        return dict(self.entity)

    def update_entity(self, patch, mode=None):
        del mode
        self.entity.update(patch)


@pytest.mark.parametrize("status", ["completed", "partial", "failed"])
def test_terminal_jobs_deliver_once_and_record_auditable_state(status, monkeypatch):
    monkeypatch.setenv("BSA_DATA_KEY_HEX", "11" * 32)
    callback = {"url": "https://hooks.example.test/ai7", "signingSecret": "secret",
                "deliveryId": "delivery-1", "apiRoot": "/service/bank_statement_analysis"}
    result = {"analysisId": "bsa_00000000-0000-0000-0000-000000000001", "status": status,
              "decisionEligible": status == "completed", "reasonCodes": [], "artifacts": []}
    job = {"id": result["analysisId"], "status": status, "completedAt": "2026-10-26T12:00:00+00:00",
           "callback": {"requested": True, "status": "pending", "deliveryId": "delivery-1", "attempts": 0}}
    prefix = f"partition/{result['analysisId']}"
    container = _Container({
        f"{prefix}/fields.bin": encrypt(json.dumps({"callback": callback}).encode()),
        f"{prefix}/result.bin": encrypt(json.dumps(result).encode()),
    })
    table = _Table({"PartitionKey": "partition", "RowKey": f"job_{result['analysisId']}",
                    "status": status, "blobPrefix": prefix, "jobJson": json.dumps(job)})
    posted = []
    monkeypatch.setattr(azure_worker, "post_signed_callback",
                        lambda config, data, completed: posted.append((config, data, completed)))

    payload = {"analysisId": result["analysisId"], "partitionKey": "partition"}
    azure_worker.deliver_terminal_callback(payload, container, table)
    azure_worker.deliver_terminal_callback(payload, container, table)

    assert len(posted) == 1
    assert posted[0][1]["status"] == status
    saved = json.loads(table.entity["jobJson"])["callback"]
    assert saved["status"] == "delivered"
    assert saved["attempts"] == 1
    assert "url" not in saved and "signingSecret" not in saved


def test_callback_failure_retries_then_exhausts_without_changing_analysis(monkeypatch):
    monkeypatch.setenv("BSA_DATA_KEY_HEX", "11" * 32)
    monkeypatch.setenv("BSA_CALLBACK_MAX_ATTEMPTS", "2")
    analysis_id = "bsa_00000000-0000-0000-0000-000000000002"
    callback = {"url": "https://hooks.example.test/ai7", "signingSecret": "secret",
                "deliveryId": "delivery-2", "apiRoot": "/service/bank_statement_analysis"}
    result = {"analysisId": analysis_id, "status": "completed", "decisionEligible": True,
              "reasonCodes": [], "artifacts": []}
    prefix = f"partition/{analysis_id}"
    job = {"id": analysis_id, "status": "completed", "completedAt": "2026-10-26T12:00:00+00:00",
           "callback": {"requested": True, "status": "pending", "deliveryId": "delivery-2", "attempts": 0}}
    container = _Container({f"{prefix}/fields.bin": encrypt(json.dumps({"callback": callback}).encode()),
                            f"{prefix}/result.bin": encrypt(json.dumps(result).encode())})
    table = _Table({"PartitionKey": "partition", "RowKey": f"job_{analysis_id}", "status": "completed",
                    "blobPrefix": prefix, "jobJson": json.dumps(job)})
    monkeypatch.setattr(azure_worker, "post_signed_callback",
                        lambda *_args: (_ for _ in ()).throw(CallbackDeliveryError("CALLBACK_HTTP_503")))
    payload = {"analysisId": analysis_id, "partitionKey": "partition"}

    with pytest.raises(CallbackDeliveryError):
        azure_worker.deliver_terminal_callback(payload, container, table)
    azure_worker.deliver_terminal_callback(payload, container, table)

    saved_job = json.loads(table.entity["jobJson"])
    assert saved_job["status"] == "completed"
    assert saved_job["callback"]["status"] == "failed"
    assert saved_job["callback"]["attempts"] == 2
