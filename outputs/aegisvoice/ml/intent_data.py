"""Provenance-aware loaders for auxiliary fraud-intent text corpora."""
import csv
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


def text_fingerprint(text):
    normalized = re.sub(r"\W+", " ", text.lower()).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def load_ncsu_transcripts(csv_path):
    path = Path(csv_path)
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        required = {"file_name", "language", "transcript", "case_details", "case_pdf"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError("NCSU metadata is missing required columns")
        rows = []
        for index, source_row in enumerate(reader):
            text = source_row["transcript"].strip()
            group = source_row["case_details"].strip()
            if not text or not group:
                raise ValueError(f"NCSU row {index + 2} is missing transcript or case grouping")
            rows.append({
                "id": f"ncsu-ftc-{index + 1:04d}",
                "source": "ncsu_ftc_robocalls",
                "source_row": index + 2,
                "published_split": "unspecified",
                "group": group,
                "language": source_row["language"].strip().lower() or "unknown",
                "turns": [{"role": "caller", "text": text}],
                "text": text,
                "label": 1,
                "type": "suspected illegal robocall",
                "hash": text_fingerprint(text),
                "label_quality": "source-level suspected-illegal label; no per-call adjudication",
                "license": "data public domain; documentation CC BY-ND 4.0",
            })
    return rows


def grouped_train_evaluation_split(rows, train_fraction=0.8):
    if not 0 < train_fraction < 1:
        raise ValueError("train_fraction must be between zero and one")
    groups = {(row["source"], row["group"]) for row in rows}
    if len(groups) < 2:
        raise ValueError("at least two source groups are required")
    ordered = sorted(groups, key=lambda item: hashlib.sha256("\0".join(item).encode("utf-8")).digest())
    cutoff = min(len(ordered) - 1, max(1, round(len(ordered) * train_fraction)))
    training_groups = set(ordered[:cutoff])
    training = [row for row in rows if (row["source"], row["group"]) in training_groups]
    evaluation = [row for row in rows if (row["source"], row["group"]) not in training_groups]
    return training, evaluation


def source_class_balanced_weights(rows):
    if not rows:
        raise ValueError("training rows are required")
    counts = Counter((row["label"], row["source"]) for row in rows)
    sources = defaultdict(set)
    for label, source in counts:
        sources[label].add(source)
    labels = set(sources)
    raw = [1 / (len(labels) * len(sources[row["label"]]) * counts[(row["label"], row["source"])]) for row in rows]
    scale = len(raw) / sum(raw)
    return [weight * scale for weight in raw]


def load_approved_intent_corpora(manifest_path):
    path = Path(manifest_path)
    if not path.exists():
        return []
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != "1.0" or not isinstance(manifest.get("corpora"), list):
        raise ValueError("intent corpus manifest must use schema_version 1.0")
    root = path.parent.resolve()
    rows = []
    seen_ids = set()
    for corpus in manifest["corpora"]:
        if corpus.get("training_allowed") is not True:
            continue
        required = ["id", "file", "source_url", "license", "license_review_id", "label_quality"]
        if any(not isinstance(corpus.get(key), str) or not corpus[key].strip() for key in required):
            raise ValueError("approved corpus metadata is incomplete")
        source_id = corpus["id"].strip()
        data_path = (root / corpus["file"]).resolve()
        if not data_path.is_relative_to(root):
            raise ValueError(f"approved corpus path escapes its root: {source_id}")
        with data_path.open(encoding="utf-8") as source:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                record = json.loads(line)
                required_record = ["id", "text", "language", "group", "match_group"]
                if any(not isinstance(record.get(key), str) or not record[key].strip() for key in required_record):
                    raise ValueError(f"{source_id} row {line_number} is missing text or grouping metadata")
                if record.get("label") not in (0, 1):
                    raise ValueError(f"{source_id} row {line_number} has an invalid label")
                record_id = f"{source_id}:{record['id'].strip()}"
                if record_id in seen_ids:
                    raise ValueError(f"duplicate approved corpus id: {record_id}")
                seen_ids.add(record_id)
                text = record["text"].strip()
                rows.append({
                    "id": record_id, "source": source_id, "source_row": line_number,
                    "published_split": record.get("published_split", "unspecified"),
                    "group": record["group"].strip(), "match_group": record["match_group"].strip(),
                    "language": record["language"].strip().lower(),
                    "turns": [{"role": "caller", "text": text}], "text": text,
                    "label": record["label"], "type": record.get("type", "licensed call transcript"),
                    "hash": text_fingerprint(text), "label_quality": corpus["label_quality"],
                    "license": corpus["license"], "license_review_id": corpus["license_review_id"],
                    "source_url": corpus["source_url"],
                })
    return rows


def load_fraud_call_india_records(records_path):
    """Load the downloaded CC0 Kaggle text release with stable deduplication.

    The release is useful intent text, not verified human-call audio. Its
    publisher labels and missing topic-pair metadata are retained explicitly.
    """
    path = Path(records_path)
    if not path.exists():
        return []
    source_rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(source_rows, list):
        raise ValueError("Fraud Call India records must be a JSON array")
    rows, seen = [], set()
    for index, record in enumerate(source_rows, 1):
        turns = record.get("turns")
        label = record.get("label")
        if label not in (0, 1) or not isinstance(turns, list):
            raise ValueError(f"Fraud Call India row {index} has an invalid label or turns")
        text = "\n".join(str(turn.get("text", "")).strip() for turn in turns if turn.get("role") == "caller").strip()
        if not text:
            raise ValueError(f"Fraud Call India row {index} has no caller text")
        digest = text_fingerprint(text)
        if digest in seen:
            continue
        seen.add(digest)
        rows.append({
            "id": record.get("id") or f"fraud-call-india-{index:04d}",
            "source": "fraud_call_india_kaggle", "source_row": record.get("source_row", index),
            "published_split": "unspecified", "group": digest, "match_group": "unavailable",
            "language": "en", "turns": [{"role": "caller", "text": text}], "text": text,
            "label": label, "type": "publisher label", "hash": digest,
            "label_quality": "publisher binary label; no independent call-level adjudication",
            "license": "CC0-1.0", "source_url": "https://www.kaggle.com/datasets/narayanyadav/fraud-call-india-dataset",
        })
    return rows
