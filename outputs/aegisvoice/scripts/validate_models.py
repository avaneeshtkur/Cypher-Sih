"""Run Pella v2 and official AASIST on the prepared public WAV registry."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import soundfile as sf

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = PROJECT.parents[1]
DATA = WORKSPACE / "data" / "public"
ARTIFACTS = PROJECT / "artifacts"
sys.path.insert(0, str(PROJECT / "ml"))
from audio_models import aasist, pella  # noqa: E402


def validate(detector, records):
    output = []
    for record in records:
        started = time.perf_counter()
        try:
            samples, rate = sf.read(DATA / record["file"], dtype="float32")
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            if rate != 16000:
                raise ValueError(f"Expected 16 kHz WAV, got {rate}")
            result = detector(samples)
            output.append({**record, "available": bool(result.get("available")), "result": result})
        except Exception as error:
            output.append({**record, "available": False, "error": str(error)[:500]})
        output[-1]["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    return output


def main():
    registry = json.loads((DATA / "registry.json").read_text())
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    for name, detector in (("pella", pella), ("aasist", aasist)):
        records = validate(detector, registry["records"])
        result = {"dataset": registry["dataset"], "detector": name, "transcriptUsed": False, "records": records}
        (ARTIFACTS / f"{name}_results.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"detector": name, "available": sum(row["available"] for row in records), "total": len(records)}))


if __name__ == "__main__":
    main()