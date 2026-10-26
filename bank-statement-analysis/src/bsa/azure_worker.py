"""Durable Azure Queue/Blob/Table worker for tenant-isolated bank statement jobs."""

import base64
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from azure.core.exceptions import ResourceNotFoundError
from azure.data.tables import TableClient, UpdateMode
from azure.identity import ManagedIdentityCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.storage.queue import QueueClient

from .callback import CallbackDeliveryError, post_signed_callback
from .crypto import decrypt, encrypt, encrypted_json
from .malware import scan_inputs
from .run_analysis import run as analyze_directory


def _urls() -> tuple[str, str, str]:
    blob = os.environ["BSA_STORAGE_BLOB_URL"].rstrip("/")
    return blob, blob.replace(".blob.", ".queue."), blob.replace(".blob.", ".table.")


def _clients():
    blob_url, queue_url, table_url = _urls()
    identity = ManagedIdentityCredential(client_id=os.getenv("BSA_WORKER_IDENTITY_CLIENT_ID"))
    container = BlobServiceClient(blob_url, credential=identity).get_container_client(
        os.getenv("BSA_STORAGE_CONTAINER", "bank-statement-analysis"))
    queue = QueueClient(queue_url, os.getenv("BSA_STORAGE_QUEUE", "bank-statement-analysis"), credential=identity)
    table = TableClient(table_url, os.getenv("BSA_STORAGE_TABLE", "BankStatementAnalysis"), credential=identity)
    return container, queue, table


def _decode_message(content: str) -> dict:
    try:
        return json.loads(base64.b64decode(content, validate=True))
    except Exception:
        return json.loads(content)


def _download(container, name: str, destination: Path) -> None:
    destination.write_bytes(container.download_blob(name).readall())


def _upload(container, name: str, path: Path, content_type: str = "application/octet-stream") -> None:
    container.upload_blob(name, path.read_bytes(), overwrite=True,
                          content_settings=ContentSettings(content_type=content_type,
                                                           cache_control="private, no-store"))


def _failure_result(analysis_id: str, reason: str) -> dict:
    return {"analysisId": analysis_id, "status": "failed", "decisionEligible": False,
            "reasonCodes": [reason], "segments": [], "features": {}, "schemaVersion": "bsa-v1.0.0"}


def _encrypted_blob_json(container, name: str) -> dict:
    return json.loads(decrypt(container.download_blob(name).readall()))


def _save_callback_state(table, entity: dict, job: dict, state: dict) -> None:
    job["callback"] = state
    table.update_entity({
        "PartitionKey": entity["PartitionKey"],
        "RowKey": entity["RowKey"],
        "callbackStatus": state["status"],
        "callbackAttempts": int(state.get("attempts", 0)),
        "jobJson": json.dumps(job),
    }, mode=UpdateMode.MERGE)


def deliver_terminal_callback(payload: dict, container, table) -> None:
    analysis_id = str(payload["analysisId"])
    partition = str(payload["partitionKey"])
    entity = table.get_entity(partition, f"job_{analysis_id}")
    if entity.get("status") not in {"completed", "partial", "failed"}:
        return
    job = json.loads(entity["jobJson"])
    state = job.get("callback") or {"requested": False, "status": "not_requested"}
    if not state.get("requested") or state.get("status") in {"delivered", "failed"}:
        return
    prefix = entity["blobPrefix"]
    fields = _encrypted_blob_json(container, f"{prefix}/fields.bin")
    callback = fields.get("callback")
    if not callback:
        _save_callback_state(table, entity, job, {"requested": False, "status": "not_requested"})
        return
    result = _encrypted_blob_json(container, f"{prefix}/result.bin")
    attempted_at = datetime.now(timezone.utc).isoformat()
    attempts = int(state.get("attempts", 0)) + 1
    try:
        post_signed_callback(callback, result, str(job.get("completedAt") or attempted_at))
    except (CallbackDeliveryError, ValueError) as error:
        max_attempts = max(1, int(os.getenv("BSA_CALLBACK_MAX_ATTEMPTS", "8")))
        exhausted = attempts >= max_attempts or isinstance(error, ValueError)
        next_state = {
            "requested": True,
            "status": "failed" if exhausted else "retrying",
            "deliveryId": callback["deliveryId"],
            "attempts": attempts,
            "lastAttemptAt": attempted_at,
            "reasonCode": str(error),
        }
        _save_callback_state(table, entity, job, next_state)
        if not exhausted:
            raise CallbackDeliveryError(str(error)) from error
        return
    _save_callback_state(table, entity, job, {
        "requested": True,
        "status": "delivered",
        "deliveryId": callback["deliveryId"],
        "attempts": attempts,
        "lastAttemptAt": attempted_at,
        "deliveredAt": datetime.now(timezone.utc).isoformat(),
    })


def _deliver_terminal_safely(payload: dict, container, table) -> None:
    try:
        deliver_terminal_callback(payload, container, table)
    except CallbackDeliveryError:
        raise
    except Exception as error:
        # Once an analysis is terminal, callback infrastructure can never rewrite
        # the analysis outcome. Transient storage/state faults stay on the queue.
        raise CallbackDeliveryError("CALLBACK_STATE_UNAVAILABLE") from error


def wait_for_malware_scanner() -> None:
    timeout = max(1, int(os.getenv("BSA_CLAMD_STARTUP_TIMEOUT_SECONDS", "180")))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            scan_inputs([("application/octet-stream", b"AI7 ClamAV readiness probe")])
            return
        except ValueError:
            time.sleep(1)
    raise RuntimeError("MALWARE_SCANNER_UNAVAILABLE")


def process(payload: dict, container, table) -> None:
    analysis_id = str(payload["analysisId"])
    partition = str(payload["partitionKey"])
    row_key = f"job_{analysis_id}"
    entity = table.get_entity(partition, row_key)
    if entity.get("status") in {"completed", "partial", "failed"}:
        _deliver_terminal_safely(payload, container, table)
        return
    job = json.loads(entity["jobJson"])
    prefix = entity["blobPrefix"]
    table.update_entity({"PartitionKey": partition, "RowKey": row_key, "status": "extracting"},
                        mode=UpdateMode.MERGE)
    with tempfile.TemporaryDirectory(prefix="ai7-bsa-") as temporary:
        directory = Path(temporary)
        (directory / "job.json").write_text(json.dumps(job), encoding="utf-8")
        _download(container, f"{prefix}/inputs.json", directory / "inputs.json")
        inputs = json.loads((directory / "inputs.json").read_text(encoding="utf-8"))
        _download(container, f"{prefix}/fields.bin", directory / "fields.bin")
        for item in inputs:
            _download(container, f"{prefix}/input-{item['index']}.bin", directory / f"input-{item['index']}.bin")
        analyze_directory(directory)
        result = encrypted_json(directory / "result.bin")
        _upload(container, f"{prefix}/result.bin", directory / "result.bin")
        for artifact in result.get("artifacts", []):
            filename = artifact["filename"]
            _upload(container, f"{prefix}/artifact.{filename}.bin", directory / f"artifact.{filename}.bin")
        completed = datetime.now(timezone.utc).isoformat()
        job.update(status=result["status"], completedAt=completed, reasonCodes=result.get("reasonCodes", []))
        table.update_entity({"PartitionKey": partition, "RowKey": row_key, "status": result["status"],
                             "completedAt": completed, "reasonCodesJson": json.dumps(result.get("reasonCodes", [])),
                             "jobJson": json.dumps(job)}, mode=UpdateMode.MERGE)
    _deliver_terminal_safely(payload, container, table)


def mark_failed(payload: dict, container, table, reason: str) -> None:
    analysis_id = str(payload.get("analysisId", "unknown"))
    partition = str(payload.get("partitionKey", "unknown"))
    result = _failure_result(analysis_id, reason)
    try:
        entity = table.get_entity(partition, f"job_{analysis_id}")
        prefix = entity["blobPrefix"]
        container.upload_blob(f"{prefix}/result.bin", encrypt(json.dumps(result).encode()), overwrite=True,
                              content_settings=ContentSettings(content_type="application/octet-stream",
                                                               cache_control="private, no-store"))
        completed = datetime.now(timezone.utc).isoformat()
        job = json.loads(entity["jobJson"])
        job.update(status="failed", completedAt=completed, reasonCodes=[reason])
        table.update_entity({"PartitionKey": partition, "RowKey": f"job_{analysis_id}", "status": "failed",
                             "completedAt": completed, "reasonCodesJson": json.dumps([reason]),
                             "jobJson": json.dumps(job)}, mode=UpdateMode.MERGE)
    except ResourceNotFoundError:
        pass


def run() -> None:
    wait_for_malware_scanner()
    container, queue, table = _clients()
    while True:
        received = list(queue.receive_messages(messages_per_page=1, visibility_timeout=int(
            os.getenv("BSA_WORKER_VISIBILITY_SECONDS", "900"))))
        if not received:
            time.sleep(2)
            continue
        message = received[0]
        payload = None
        try:
            payload = _decode_message(message.content)
            process(payload, container, table)
            queue.delete_message(message)
        except CallbackDeliveryError:
            retry_seconds = min(3600, 60 * (2 ** min(max(message.dequeue_count - 1, 0), 6)))
            queue.update_message(message, visibility_timeout=retry_seconds)
        except Exception:
            if message.dequeue_count >= 3 and payload:
                mark_failed(payload, container, table, "ANALYSIS_FAILED")
                try:
                    process(payload, container, table)
                    queue.delete_message(message)
                except CallbackDeliveryError:
                    queue.update_message(message, visibility_timeout=60)
            else:
                queue.update_message(message, visibility_timeout=30)


if __name__ == "__main__":
    run()
