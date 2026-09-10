"""Download and normalize a small ASVspoof2019_LA validation subset."""
from __future__ import annotations

import importlib
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = PROJECT.parents[1]
OUTPUT = WORKSPACE / "data" / "public"
DATASET = "SpeechAntiSpoofingBenchmarks/ASVspoof2019_LA"


def require(module: str, package: str | None = None):
    try:
        return importlib.import_module(module)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "--break-system-packages", package or module])
        return importlib.import_module(module)


def label_of(row: dict) -> str | None:
    for key in ("label", "target", "is_spoof", "spoof"):
        value = row.get(key)
        if isinstance(value, dict):
            value = value.get("name", value.get("id"))
        value = str(value).lower()
        if value in {"bonafide", "genuine", "real", "0", "false"}:
            return "bonafide"
        if value in {"spoof", "synthetic", "fake", "1", "true"}:
            return "spoof"
    return None


def main() -> None:
    datasets = require("datasets")
    np = require("numpy")
    soundfile = require("soundfile")
    resample_poly = require("scipy.signal").resample_poly
    rows = datasets.load_dataset(DATASET, split="train", streaming=True)
    counts = {"bonafide": 0, "spoof": 0}
    records = []
    for row in rows:
        label = label_of(row)
        if label is None or counts[label] >= 15:
            if all(value == 15 for value in counts.values()):
                break
            continue
        audio = row.get("audio") or row.get("wav")
        if not isinstance(audio, dict) or "array" not in audio:
            raise ValueError("Dataset audio feature did not contain decoded samples")
        samples = np.asarray(audio["array"], dtype="float32")
        rate = int(audio.get("sampling_rate", 16000))
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if rate != 16000:
            samples = resample_poly(samples, 16000, rate).astype("float32")
        filename = f"{label}_{counts[label] + 1:02d}.wav"
        target = OUTPUT / label / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        soundfile.write(target, np.clip(samples, -1, 1), 16000, subtype="PCM_16", format="WAV")
        records.append({"id": filename[:-4], "file": f"{label}/{filename}", "label": label,
                        "sampleRate": 16000, "channels": 1})
        counts[label] += 1
    if counts != {"bonafide": 15, "spoof": 15}:
        raise RuntimeError(f"Could not collect 15 samples per class: {counts}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "registry.json").write_text(json.dumps({"dataset": DATASET, "classes": counts, "records": records}, indent=2) + "\n")
    print(json.dumps({"output": str(OUTPUT), "classes": counts}))


if __name__ == "__main__":
    main()