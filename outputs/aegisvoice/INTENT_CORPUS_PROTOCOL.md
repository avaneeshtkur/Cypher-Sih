# Licensed intent corpus intake

Place approved Hindi, Indian-English BFSI, or other call transcripts under
`work/datasets/intent-corpora`. Training ignores this directory unless it contains
a `manifest.json` entry with `training_allowed: true` and a nonempty licence review ID.

```json
{
  "schema_version": "1.0",
  "corpora": [{
    "id": "licensed_hindi_call_center",
    "file": "hindi-call-center.jsonl",
    "source_url": "https://provider.example/dataset",
    "license": "record the applicable licence",
    "license_review_id": "review-ticket-or-document-id",
    "label_quality": "describe consent and independent adjudication",
    "training_allowed": true
  }]
}
```

Each JSONL record must contain a stable ID, transcript text, binary label, language,
leakage group, and matched-topic group:

```json
{"id":"call-0001","text":"...","label":1,"language":"hi","group":"campaign-or-speaker-id","match_group":"bank-alert"}
```

`group` keeps the same speaker, campaign, or conversation out of both training and
evaluation. `match_group` links fraud and genuine calls about the same topic so topic
alone cannot determine the label. Raw audio remains outside the text classifier;
transcribe it with the multilingual local ASR and review/redact it before intake.

The bundled NCSU/FTC catalogue is source-level weak positive supervision and has no
benign controls. The three INDICA Assamese clips are synthetic, currently transcribe
poorly, and are evaluation-only. WiserBrand Hindi and FutureBeeAI BFSI data remain
excluded until their access and licence terms are satisfied.