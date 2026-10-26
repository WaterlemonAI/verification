import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .crypto import encrypt, encrypted_json
from .capabilities import worker_capabilities


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def atomic_encrypted_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(encrypt(json.dumps(value, ensure_ascii=False).encode()))
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def process_job(directory: Path) -> bool:
    queued = directory / "queued"
    processing = directory / "processing"
    try:
        os.replace(queued, processing)
    except FileNotFoundError:
        return False
    processing.touch()
    job_path = directory / "job.json"
    job = None
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
        if (directory / "result.bin").exists():
            prior = encrypted_json(directory / "result.bin")
            job["status"] = prior["status"]
            job["reasonCodes"] = prior.get("reasonCodes", [])
            job["completedAt"] = job.get("completedAt") or datetime.now(timezone.utc).isoformat()
            atomic_json(job_path, job)
            processing.unlink(missing_ok=True)
            return True
        job["status"] = "extracting"
        atomic_json(job_path, job)
        try:
            subprocess.run([sys.executable, "-m", "bsa.run_analysis", str(directory)],
                           check=True, timeout=int(os.getenv("BSA_WORKER_TIMEOUT_SECONDS", "600")),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result = encrypted_json(directory / "result.bin")
        except subprocess.TimeoutExpired:
            result = {"analysisId": directory.name, "status": "failed", "decisionEligible": False,
                      "reasonCodes": ["PARSER_TIMEOUT"], "segments": [], "features": {}, "schemaVersion": "bsa-v1.0.0"}
            atomic_encrypted_json(directory / "result.bin", result)
        job["status"] = result["status"]
        job["reasonCodes"] = result["reasonCodes"]
    except Exception:
        result = {"analysisId": directory.name, "status": "failed", "decisionEligible": False,
                  "reasonCodes": ["ANALYSIS_FAILED"], "segments": [], "features": {}, "schemaVersion": "bsa-v1.0.0"}
        atomic_encrypted_json(directory / "result.bin", result)
        job = {**(job or {"id": directory.name}), "status": "failed", "reasonCodes": ["ANALYSIS_FAILED"]}
    job["completedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_json(job_path, job)
    processing.unlink(missing_ok=True)
    return True


def recover_stale_job(directory: Path, max_age_seconds: int) -> bool:
    processing = directory / "processing"
    if not processing.exists() or time.time() - processing.stat().st_mtime <= max_age_seconds:
        return False
    try:
        job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
        job["status"] = "queued"
        job["retryCount"] = int(job.get("retryCount", 0)) + 1
        atomic_json(directory / "job.json", job)
        os.replace(processing, directory / "queued")
        return True
    except (OSError, ValueError, KeyError):
        return False


def run(data_dir: Path, watch: bool) -> None:
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    capabilities = worker_capabilities()
    readiness_path = data_dir / "worker-capabilities.json"
    last_readiness = 0.0
    jobs = data_dir / "jobs"
    jobs.mkdir(parents=True, exist_ok=True, mode=0o700)
    while True:
        if time.time() - last_readiness > 5:
            atomic_json(readiness_path, capabilities)
            last_readiness = time.time()
        processed = False
        for directory in jobs.iterdir():
            if not directory.is_dir():
                continue
            recover_stale_job(directory, int(os.getenv("BSA_WORKER_TIMEOUT_SECONDS", "600")) + 30)
            if (directory / "queued").exists():
                processed = process_job(directory) or processed
        if not watch:
            return
        if not processed:
            time.sleep(0.5)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=os.getenv("BSA_DATA_DIR", ".local-bsa"))
    parser.add_argument("--watch", action="store_true")
    arguments = parser.parse_args()
    run(Path(arguments.data_dir), arguments.watch)


if __name__ == "__main__":
    main()
