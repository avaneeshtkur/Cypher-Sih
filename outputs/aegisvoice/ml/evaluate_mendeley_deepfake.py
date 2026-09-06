"""Evaluate installed Mendeley synthetic-only audio with Pella and AASIST.

This reports detection sensitivity only.  With no genuine class, specificity,
precision, balanced accuracy, and an operational authenticity threshold cannot
be estimated from this corpus.
"""
import argparse, json, sys, time
from collections import defaultdict
from pathlib import Path

from audio_models import aasist, pella
from audio_io import decode_audio

APP = Path(__file__).resolve().parents[1]
WORK = APP.parents[1] / "work"
DATASET = WORK / "datasets" / "mendeley-fake-audio-v1"
RECORDS = DATASET / "records.json"
MODELS = APP / "models"

def summary(rows):
    total = len(rows)
    pella_hits = sum(row["pellaLabel"] == "synthetic-like" for row in rows)
    aasist_hits = sum(row["aasistLabel"] == "spoof-like" for row in rows)
    either = sum(row["pellaLabel"] == "synthetic-like" or row["aasistLabel"] == "spoof-like" for row in rows)
    both = sum(row["pellaLabel"] == "synthetic-like" and row["aasistLabel"] == "spoof-like" for row in rows)
    return {"n": total, "pellaSyntheticDetectionRate": pella_hits / total,
            "aasistSpoofDetectionRate": aasist_hits / total,
            "eitherDetectorRate": either / total, "bothDetectorsRate": both / total,
            "detectorDisagreementRate": (either - both) / total}

def stratified(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["tool"], row["generationType"], row["gender"])].append(row)
    ordered = []
    while groups:
        for key in sorted(list(groups)):
            if groups[key]: ordered.append(groups[key].pop(0))
            if not groups[key]: del groups[key]
    return ordered

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Stratified record limit; 0 evaluates all 600.")
    args = parser.parse_args()
    source = json.loads(RECORDS.read_text(encoding="utf-8"))
    selected = stratified(source)
    if args.limit: selected = selected[:args.limit]
    results = []
    started = time.time()
    for index, record in enumerate(selected, 1):
        samples = decode_audio((WORK / record["relativePath"]).read_bytes())
        left, right = pella(samples), aasist(samples)
        results.append({"id": record["id"], "tool": record["tool"], "generationType": record["generationType"],
                        "gender": record["gender"], "ageGroup": record["ageGroup"],
                        "pellaScore": left["score"], "pellaLabel": left["label"],
                        "aasistScore": right["score"], "aasistLabel": right["label"]})
        if index % 25 == 0 or index == len(selected):
            print(f"Mendeley deepfake evaluation: {index}/{len(selected)}", flush=True)
    breakdown = {}
    for field in ("tool", "generationType", "gender", "ageGroup"):
        breakdown[field] = {value: summary([row for row in results if row[field] == value])
                            for value in sorted({row[field] for row in results})}
    report = {
        "dataset": "Mendeley Fake Audio Dataset (ElevenLabs & Respeecher)",
        "doi": "10.17632/79g59sp69z.1", "version": 1, "license": "CC BY 4.0",
        "evaluatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "selection": "all installed records" if len(results) == len(source) else "deterministic stratified prefix",
        "installedCount": len(source), "evaluatedCount": len(results), "overall": summary(results),
        "breakdown": breakdown, "runtimeSeconds": time.time() - started,
        "limitations": [
            "All 600 recordings are publisher-labelled synthetic audio; there is no genuine class.",
            "Detection rates are sensitivity on this corpus, not accuracy, precision, specificity, or real-world calibration.",
            "Speaker/source identities and source utterance grouping are not provided, so this corpus is not used for random clip-level training splits.",
            "The workbook reports 22,050 Hz for every row, but measured WAV headers are 44,100 Hz or 48,000 Hz.",
            "The dataset has no scam-intent labels and does not train or validate fraud-request classification."
        ]
    }
    suffix = "" if len(results) == len(source) else f"-{len(results)}"
    (MODELS / f"mendeley_deepfake_report{suffix}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (MODELS / f"mendeley_deepfake_examples{suffix}.json").write_text(json.dumps(results) + "\n", encoding="utf-8")
    print(json.dumps(report["overall"], indent=2), flush=True)
