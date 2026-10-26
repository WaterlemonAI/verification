"""Repeatable, synthetic-only local throughput measurement."""

import argparse
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

from create_demo_fixture import create

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bsa.engine import analyze  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=3)
    arguments = parser.parse_args()
    if not 1 <= arguments.iterations <= 20:
        raise SystemExit("iterations must be between 1 and 20")
    with tempfile.TemporaryDirectory(prefix="bsa-benchmark-") as directory:
        sample = Path(directory) / "synthetic.pdf"
        create(sample)
        data = sample.read_bytes()
        samples = []
        result = None
        for index in range(arguments.iterations):
            started = time.perf_counter()
            result = analyze(data, f"benchmark_{index}", tenant_scope="synthetic_benchmark")
            samples.append(time.perf_counter() - started)
        print(json.dumps({"fixture": "synthetic-only", "iterations": arguments.iterations,
                          "pageCount": result["coverage"]["pageCount"],
                          "transactionCount": result["coverage"]["transactionCount"],
                          "medianSeconds": round(statistics.median(samples), 3),
                          "maximumSeconds": round(max(samples), 3),
                          "externalProviderCalls": 0,
                          "note": "Local measurements are not service-level commitments."}))


if __name__ == "__main__":
    main()
