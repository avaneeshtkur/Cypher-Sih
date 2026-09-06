# Interactive human-vishing evidence protocol

This protocol defines evidence that may be evaluated by AegisVoice. It does not authorize collection. Collection may begin only after the data controller, legal/privacy reviewers and any required ethics body approve a written protocol for the relevant jurisdictions.

## Non-qualifying proxy tracks

Robocalls, TTS-regenerated speech, scripted role-play, ASVspoof recordings and synthetic voice-conversion transforms must be catalogued separately. They may test channels, scripts or model plumbing, but they cannot be labelled as recordings of interactive human scam calls. Public URLs are not evidence that audio was downloaded, licensed for redistribution or evaluated locally.

## Required corpus layout

Place partner-controlled material under `work/datasets/human-vishing/`:

```text
manifest.json
audio/<opaque-record-id>.<approved-format>
governance/<legal, privacy, redaction and adjudication evidence>
evaluation/protocol.json
evaluation/predictions.jsonl
evaluation/external-review.pdf
```

The directory is ignored by version control. Do not put victim names, telephone numbers, account data, OTPs or unredacted transcripts in filenames or the application repository.

## Record requirements

Each record requires a relative audio path and SHA-256, fraud/genuine label, human/automated caller mode, interactive/prerecorded status, topic and matched-control group, campaign group, caller and victim speaker groups, script family, source-recording group, split, channel, codec, language, accent, legal-basis artifact, redaction-review artifact, adjudication artifact, at least two independent annotators, at least four turns and two responsive turns, and voice-conversion status.

“Responsive turn” means the speaker reacts to content that was not completely determined before the other party's preceding turn. Silence, IVR navigation and a prerecorded branch do not by themselves establish human interaction.

## Separation and controls

Caller, victim, campaign, script-family, source-recording and matched-control groups must remain in one split. The sealed test set cannot be inspected for rule writing, threshold selection or model selection. Every evaluated scam topic requires genuine controls matched as closely as possible on language, channel, organization type and request topic.

The built-in minimum gate is 100 byte-verified scam and 100 byte-verified genuine test calls, five matched topics with ten examples per label, two languages and two channel/codec conditions. A study should justify larger sample sizes using target error bounds and expected prevalence.

## Live voice-conversion track

Record this separately. A human operator must speak through an identified real-time VC system and respond to unpredictable questions over the target codec. Include the same speakers and channels without VC where lawful. Record software/version, latency, device, room, codec and whether the path is microphone, virtual cable, WebRTC or PSTN. A TTS file or offline conversion does not qualify.

## Evaluation report

Report sensitivity, specificity, false-positive rate, false-negative rate, precision at stated prevalence, calibration, abstention coverage and latency with confidence intervals. Break results down by topic, language/accent, channel/codec, caller mode and VC status. Include failures and missing data. The manifest must hash a sealed protocol, prediction file and external review artifact.

Passing the automated audit means only that the evidence package satisfies these mechanical checks. It never establishes legality, consent, scientific validity, operational safety, identity or deployment fitness.
