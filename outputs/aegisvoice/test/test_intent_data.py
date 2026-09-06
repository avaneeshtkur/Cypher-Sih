import sys
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from intent_data import grouped_train_evaluation_split, load_approved_intent_corpora, load_fraud_call_india_records, load_ncsu_transcripts, source_class_balanced_weights


class IntentDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = load_ncsu_transcripts(ROOT / "database-audio" / "ncsu-metadata.csv")

    def test_complete_ncsu_catalogue_is_loaded_with_provenance(self):
        self.assertEqual(len(self.rows), 1432)
        self.assertEqual(sum(row["language"] == "en" for row in self.rows), 1378)
        self.assertEqual(len({row["group"] for row in self.rows}), 31)
        self.assertTrue(all(row["label"] == 1 for row in self.rows))
        self.assertTrue(all(row["label_quality"] and row["license"] for row in self.rows))

    def test_campaign_groups_never_cross_training_and_evaluation(self):
        training, evaluation = grouped_train_evaluation_split(self.rows)
        training_groups = {row["group"] for row in training}
        evaluation_groups = {row["group"] for row in evaluation}
        self.assertTrue(training and evaluation)
        self.assertTrue(training_groups.isdisjoint(evaluation_groups))
        reversed_split = grouped_train_evaluation_split(list(reversed(self.rows)))
        self.assertEqual({row["id"] for row in training}, {row["id"] for row in reversed_split[0]})

    def test_weights_balance_labels_then_sources(self):
        rows = [
            {"label": 0, "source": "base"}, {"label": 0, "source": "base"},
            {"label": 1, "source": "base"},
            {"label": 1, "source": "ncsu"}, {"label": 1, "source": "ncsu"}, {"label": 1, "source": "ncsu"},
        ]
        weights = source_class_balanced_weights(rows)
        totals = {}
        for row, weight in zip(rows, weights):
            totals[(row["label"], row["source"])] = totals.get((row["label"], row["source"]), 0) + weight
        self.assertAlmostEqual(totals[(0, "base")], totals[(1, "base")] + totals[(1, "ncsu")])
        self.assertAlmostEqual(totals[(1, "base")], totals[(1, "ncsu")])

    def test_only_explicitly_approved_grouped_corpora_are_loaded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "approved.jsonl").write_text(json.dumps({
                "id": "call-1", "text": "Use the official bank app.", "label": 0,
                "language": "hi", "group": "speaker-1", "match_group": "bank-alert",
            }) + "\n", encoding="utf-8")
            manifest = {"schema_version": "1.0", "corpora": [
                {"id": "licensed_hindi", "file": "approved.jsonl", "source_url": "https://example.test/source",
                 "license": "licensed", "license_review_id": "review-1", "label_quality": "independently adjudicated", "training_allowed": True},
                {"id": "restricted_bfsi", "training_allowed": False},
            ]}
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            rows = load_approved_intent_corpora(root / "manifest.json")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["source"], "licensed_hindi")
            self.assertEqual(rows[0]["match_group"], "bank-alert")
            self.assertEqual(rows[0]["license_review_id"], "review-1")

    def test_fraud_call_india_loader_deduplicates_and_retains_label_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.json"
            path.write_text(json.dumps([
                {"id": "a", "label": 1, "turns": [{"role": "caller", "text": "Read the OTP now"}]},
                {"id": "duplicate", "label": 1, "turns": [{"role": "caller", "text": "Read the OTP now!"}]},
                {"id": "b", "label": 0, "turns": [{"role": "caller", "text": "Use the official support number"}]},
            ]), encoding="utf-8")
            rows = load_fraud_call_india_records(path)
            self.assertEqual(len(rows), 2)
            self.assertEqual({row["label"] for row in rows}, {0, 1})
            self.assertTrue(all(row["license"] == "CC0-1.0" for row in rows))
            self.assertTrue(all("no independent" in row["label_quality"] for row in rows))


if __name__ == "__main__":
    unittest.main()
