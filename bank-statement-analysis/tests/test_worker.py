import json
import os
import time
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from create_demo_fixture import create  # noqa: E402

from bsa.worker import process_job, recover_stale_job  # noqa: E402
from bsa.crypto import decrypt, encrypt  # noqa: E402


def test_worker_completes_private_artifacts_and_keeps_partial_ineligible(tmp_path, monkeypatch):
    monkeypatch.setenv("BSA_DATA_KEY_HEX", "11" * 32)
    job_dir = tmp_path / "jobs" / "bsa_synthetic"
    job_dir.mkdir(parents=True)
    sample = tmp_path / "sample.pdf"
    create(sample)
    (job_dir / "input-0.bin").write_bytes(encrypt(sample.read_bytes()))
    (job_dir / "inputs.json").write_text('[{"index":0,"mediaType":"application/pdf"}]')
    (job_dir / "fields.bin").write_bytes(encrypt(b'{"getPdf": true}'))
    (job_dir / "job.json").write_text(json.dumps({"id": "bsa_synthetic", "status": "queued", "encrypted": True}))
    (job_dir / "queued").write_text("")
    assert process_job(job_dir)
    job = json.loads((job_dir / "job.json").read_text())
    result = json.loads(decrypt((job_dir / "result.bin").read_bytes()))
    assert job["status"] == "partial"
    assert result["decisionEligible"] is False
    assert result["quality"]["visualTextCheck"]["checkedPages"] == list(range(1, 9))
    assert result["quality"]["visualTextCheck"]["mismatchPages"] == []
    assert {item["filename"] for item in result["artifacts"]} == {"ledger.json", "transactions.parquet", "audit.pdf"}
    assert (job_dir / "input-0.bin").read_bytes().startswith(b"BSA1")
    assert decrypt((job_dir / "artifact.audit.pdf.bin").read_bytes()).startswith(b"%PDF-")
    assert decrypt((job_dir / "artifact.transactions.parquet.bin").read_bytes()).startswith(b"PAR1")
    assert all(item["bytes"] > 0 for item in result["artifacts"])


def test_stale_job_recovers_completed_result_without_reprocessing(tmp_path, monkeypatch):
    monkeypatch.setenv("BSA_DATA_KEY_HEX", "11" * 32)
    job_dir = tmp_path / "jobs" / "bsa_recovered"
    job_dir.mkdir(parents=True)
    result = {"status": "partial", "reasonCodes": ["REVIEW_REQUIRED"]}
    (job_dir / "result.bin").write_bytes(encrypt(json.dumps(result).encode()))
    (job_dir / "job.json").write_text(json.dumps({"id": "bsa_recovered", "status": "extracting"}))
    marker = job_dir / "processing"
    marker.touch()
    old = time.time() - 300
    os.utime(marker, (old, old))

    assert recover_stale_job(job_dir, 180)
    assert (job_dir / "queued").exists()
    assert process_job(job_dir)
    job = json.loads((job_dir / "job.json").read_text())
    assert job["status"] == "partial"
    assert job["reasonCodes"] == ["REVIEW_REQUIRED"]
    assert job["retryCount"] == 1
    assert not marker.exists()
    assert not (job_dir / "queued").exists()
