# AegisVoice - local call-verification prototype

A browser workspace for inspecting social-engineering requests and limited voice-verification evidence. **Not a validated fraud detector, voice-cloning detector or caller-authentication service.**

## Run

From this directory, run `node server.mjs` (Node.js 20+) and open **[http://127.0.0.1:4173](http://127.0.0.1:4173)**. The server binds to loopback only. `Start AegisVoice.cmd` is the Windows launcher.

No downloads are needed for the bundled audio player, guided demos, transcript rules or saved dataset browsing. Python environments, ASR weights and original dataset WAVs are **not guaranteed to be included** in a project download.

The readiness endpoint checks the configured interpreter, required imports and model assets. It does not prove model quality or rerun the stored evaluations. Unavailable capabilities are disabled; there is no silent substitute for ASR.

## Four focused workspaces

### 1. Call desk

**Guided demo** plays one of four bundled TTS clips:

| Clip | Authored scenario |
| --- | --- |
| `payment-pressure.wav` | Sensitive payment plus urgency, secrecy and approval bypass |
| `legitimate-payment.wav` | Urgent payment with ordinary verification safeguards |
| `digital-arrest.wav` | Claimed police authority and coercion |
| `refund-lure.wav` | Prize/refund lure, KYC and OTP request |

This mode uses the **supplied script**, not recognized speech. Sentence cues are estimated from word counts and the media duration; they are not word-aligned ASR timestamps. As the player crosses a cue boundary, the real text rule engine evaluates only that script prefix. Pausing stops input advancement. Seeking backward removes future transcript and decision entries.

The decision log records the resulting state, exact matched phrases, safeguards and exclusions. It does not simulate an AI thinking process or use delayed animations to suggest computation. The exported guided-demo session includes its authored-text provenance and approximate timing.

**Recognize this audio with local ASR** is a different, model-backed operation. It sends the selected WAV bytes to `/api/transcribe` without the demo script, displays the recognized text and model-derived segment timestamps, then evaluates those words with the actual text rules. The response is a batch result; timestamps locate speech in the recording, not when the UI received a streaming result. The export keeps this under `recordedAudioRecognition`, separate from `guidedDemo`, with the input SHA-256, backend and elapsed inference time.

**Live audio** is a separate mode. When a streaming-capable ASR backend is available, microphone/shared audio is captured with Web Audio/AudioWorklet, encoded as PCM WAV, transcribed through `/api/transcribe`, and analysed as recognized phrases arrive. The optional trained text classifier runs through `/api/intent`. Errors and dropped chunks are coverage gaps, not successful detections. Continuous capture is disabled for the current slow OpenAI `medium` CPU backend; use a recorded clip instead.

Live capture has no speaker diarization. Captured speech is unattributed; employee and caller speech may be mixed. The latest two minutes supply rule context; earlier strong warnings remain in the session. Browser capture requires explicit permission and is not direct mobile/PSTN interception.

### 2. Transcript lab

Paste `Caller:` and `Employee:` turns or load a saved conversation from the evidence library. Caller utterances drive category/action matches; employee turns provide verification-resistance context.

The engine uses inspectable English phrase/context rules with partial Hindi, Hinglish and Marathi patterns. It is not semantic understanding from an LLM. A separate word/character TF-IDF classifier can add evidence for languages listed in the trained report; the current artifact supports English. Other languages remain rule-only until approved labelled data is added.

Explanations show the rule result immediately, including safeguards and excluded phrases. A low learned score cannot clear strong explicit instructions. No result establishes that a call is safe.

The **Authored call library** contains 18 multi-turn examples:

- 6 scam-like: CFO payment pressure, digital arrest, OTP extraction, remote-support takeover, refund fee and vendor bank-detail change;
- 6 genuine: controlled supplier payment, safe bank fraud alert, scheduled IT ticket, payroll portal update, delivery confirmation and appointment reminder;
- 6 unclear: urgent invoice, official-app refund notice, KYC reminder, new beneficiary with approval, prize survey and security warning.

The authored reference (`scam-like`, `genuine`, `unclear`) and explanation are display metadata. Only each case's `role` and `text` turns enter `analyze()`. The library intentionally includes unclear cases that split between **suspicious request detected** and **no explicit scam behavior detected**; none is forced into a high-risk verdict. Four cases link to matching local audio.

### 3. Voice check

Issue a fresh, single-use two-minute phrase, record only the reply and review its transcript. Typed matching words alone leave liveness **Not established**. Replay-like evidence cannot be cleared by a correct phrase. Recording must stop before a response can be checked.

Optional reference/reply profiling uses browser-decoded audio resampled to 16 kHz, limited to the first eight seconds. Channel distances and heuristic quality values are **not calibrated probabilities**. A codec, microphone or room change can change them without an attack. A matching channel cannot prove live speech.

Replay inference is an LFCC/SVM benchmark classifier, not a modern TTS/voice-conversion detector. Phrase checks, channel statistics and replay results never establish identity or authority. Manual response timing is recorded but not used to decide authenticity.

### 4. Evidence library

Browse saved labels, predictions, source links, report metrics and limitations without mixing them with current inference. Open a conversation in the transcript lab to run current rules on it. Its saved label is not supplied to the model.

Only four summary cards are visible initially; details are expandable. Original waveform playback is disabled when those files are absent. Saved reports remain browsable when inference is unavailable.

### 5. Attack lab

An experimental rolling DSP model compares four **delivery-path hypotheses**:

1. live human through a microphone,
2. live voice conversion on a shared/digital path,
3. direct pre-generated injection,
4. recording replayed through a physical speaker.

This is not a trained four-class deepfake model. `attack-model.mjs` extracts bounded four-second observations (maximum 16 kHz and 12 rolling windows) using:

- capture provenance (microphone, shared audio or known digital file),
- reverberation/acoustic-space proxy,
- high-band energy, spectral centroid/flatness/tilt and clipping,
- noise-floor level and window-to-window continuity,
- crest factor, envelope variation, zero-crossing rate and harmonicity.

`classifyAttackPath()` returns normalized **support weights**, contradictions, an uncertainty value and a leading class only when evidence/margin gates clear. Support values summing to 100 are display weights, **not probabilities**. Voice conversion has stricter gates and remains uncertain without repeated independent cues. Known direct-file provenance can establish a delivery route; it does not establish how the file itself was created.

Real demo paths:

- **Direct digital file:** browser decodes a bundled WAV and uses its known digital provenance. Rolling windows appear as the audio player advances; pause stops new evidence and seeking backward removes future windows.
- **Microphone:** speak live, or play a recording through another physical speaker into the microphone.
- **Shared/tab audio:** capture a browser call, virtual cable or external voice-conversion output.

An optional reference label documents what the operator says they performed. It is not supplied to support scoring. Exports explicitly record `referenceLabelUsedForClassification: false`.

For a one-laptop physical replay demonstration, select Microphone, start the 12-second capture, then play the included replay-test clip from the same panel. The waveform travels through the laptop speaker, room and microphone before analysis. Headphones defeat that path. The scenario filename and optional operator label are not model inputs.

The three canvases visualize actual PCM processed by the model: waveform, approximate spectrum and rolling noise continuity. The feature cards and per-class explanations expose exactly which cues and counter-cues moved support.

Four visible **controlled calibration simulations** exercise the display when physical equipment or a voice-conversion tool is unavailable. They are deterministic transforms of generated speech-like signals:

- live-like early reflections plus colored noise,
- phase/smoothing/quantization VC proxy (**not a real vocoder**),
- clean digital signal,
- low-pass speaker coloration, sparse echoes and recapture noise.

The expected simulation label is retained only for comparison and is tested not to leak into scores. In the saved calibration, the VC proxy remains uncertain; this is the correct result when overlapping heuristic cues cannot identify that class.

Run `node tools\calibrate-attack-model.mjs` to regenerate `models/attack_calibration.json`. It uses 12 trials per controlled condition and records confusion, support ranges, margins and overlap. It is a software behavior diagnostic—not field validation.

Current controlled outcomes are intentionally not perfect: all 12 VC-proxy trials remain uncertain, and 7 of 12 speaker-replay-proxy trials remain uncertain. Direct-file provenance is consistently separable because that route is known metadata rather than an acoustic guess. These numbers are shown as limitations, not accuracy claims.

## Where the datasets came from

These are research datasets already referenced by the project, not a proprietary database of real scam callers.

| Source | Contents and strength | Licence |
| --- | --- | --- |
| [BothBosu single-agent scam conversations](https://huggingface.co/datasets/BothBosu/single-agent-scam-conversations) | Synthetic English dialogues generated with `meta-llama-3-70b-instruct`; useful for prototyping, not real-call validation | Apache 2.0 |
| [BothBosu multi-agent scam conversations](https://huggingface.co/datasets/BothBosu/multi-agent-scam-conversation) | Synthetic agent conversations using AutoGen/Together; shares scenario families with the first source | Apache 2.0 |
| [NCSU / FTC Robocall Audio Dataset](https://github.com/wspr-ncsu/robocall-audio-dataset) | 1,432 deployed robocall transcripts; source-level suspected-illegal labels, no benign controls or per-call adjudication | Data public domain; documentation CC BY-ND 4.0 |
| [ASVspoof 2017 V2](https://doi.org/10.7488/ds/2332) | University of Edinburgh replay-spoofing benchmark; not scam transcripts or validation for modern voice clones | CC BY-NC 4.0 |
| [Mendeley Fake Audio Dataset](https://data.mendeley.com/datasets/79g59sp69z/1) | 600 publisher-labelled ElevenLabs/Respeecher TTS and V2V WAVs; synthetic-only external challenge set | CC BY 4.0 |

Pinned text revisions in [models/sources.json](models/sources.json):

- Single-agent: `1debe2743472927cd4ed3bf39e8b0d8234bd5e3f`
- Multi-agent: `709db2b6c37f424c3070f29138abb33971e21ab9`

The saved text example index contains 1,920 conversations: 320 published-test and 1,600 transfer records. The audio index contains metadata for 13,306 evaluation recordings; an index entry is **not** proof its WAV is present.

The source manifest records URLs, revisions, retrieval dates, sizes and SHA-256 values from the original build. The UI does not rehash the downloaded source archives or verify split separation on page load.

### Important evaluation correction

The rule benchmark reused the entire text corpus while inspecting errors and changing rules. Splitting those records afterward does **not** create a blind held-out test. Older claims of "85.3% held-out accuracy" and "no overfitting" were unsupported and have been withdrawn.

[models/rules_benchmark.json](models/rules_benchmark.json) is now labelled a **reused-corpus diagnostic**. Its alternating partitions are bookkeeping only. Regression tests check repeatable behaviour, not independent generalization.

All eight scenario families in this corpus have one label each: appointment/delivery/insurance/wrong are non-scam; refund/reward/SSN/support are scam. Topic alone can predict the label. High agreement on this corpus does not show reliable detection of malicious intent.

The current intent artifact fits 5,500 transcripts: 1,024 BothBosu training conversations, 576 deduplicated English NCSU/FTC weak-positive transcripts, and 3,900 deduplicated Fraud Call India records. NCSU rows are split by FTC case: 148 calls from six cases are held out, with saved sensitivity about 99.3%. This positive-only result cannot estimate specificity, precision, or a real-call false-positive rate. Fraud Call India is split by source group into training, calibration, and untouched evaluation partitions; it contributes publisher-labelled CC0 text, not independently adjudicated human-call audio.

Every usable transcript receives one of three direct risk classifications: **high-risk scam-like**, **elevated-risk / use caution**, or **low-risk / legitimate-like**. The binary threshold and the two strict-confidence thresholds are selected only from the 256-record BothBosu development partition plus 836 Fraud Call India calibration records. On the untouched 836-record Fraud Call India partition, 92.2% fell into a strict high/low confidence band; accuracy within those strict bands was about 99.6%, high-risk precision 100%, and low-risk negative predictive value about 99.6%. Middle-band inputs receive the elevated-risk classification instead of an inconclusive verdict. Unusable, silent, or out-of-domain transcripts are identified as input failures rather than guessed. These are dataset-specific evaluation figures, not proof of caller identity or a guarantee of real-world fraud. Explicit behavioural rules can elevate a suspicious request and prevent a conflicting low-risk display. Character 3–5 grams improve tolerance to ASR spelling and transliteration variation.

Approved Hindi or Indian-English BFSI transcripts can be added through [INTENT_CORPUS_PROTOCOL.md](INTENT_CORPUS_PROTOCOL.md). The loader requires explicit training permission, a licence review ID, campaign/speaker grouping, and matched-topic grouping. WiserBrand and FutureBeeAI data are not bundled and remain excluded until licensed files are supplied. The official INDICA release is public but its ten compressed language archives total about 362 GB (roughly 26–51 GB each); only three synthetic Assamese samples are currently bundled, so the project does not claim a full INDICA installation. Fraud Call India is useful as weakly labelled text training data, but it does not repair the missing independently verified interactive-human scam-call corpus.

The Mendeley V1 archive and workbook are hash-verified and all 600 WAVs are installed under `work/datasets/mendeley-fake-audio-v1`; eight generator/type/gender-stratified clips are copied into Call Desk. On all 600 clips, Pella detected 96.3%, AASIST 61.7%, either detector 98.5%, and the two detectors disagreed on 39.0%. These are sensitivity figures on a synthetic-only set—not accuracy, specificity, precision, or fraud detection. The installer also preserves a publisher-metadata defect: all 600 rows claim 22.05 kHz while their WAV headers report 44.1 or 48 kHz, and 54 published duration values differ from the waveform by more than 1.1 seconds.

The saved replay report itself shows major limitations: AUROC about 0.804, balanced accuracy about 72.2%, and substantial false acceptance/rejection rates. This cannot be used as an authentication gate.

## Existing libraries and actual inference

| Component | Implementation | Required locally |
| --- | --- | --- |
| Audio capture/playback | Browser Web Audio, AudioWorklet, MediaRecorder and HTML audio | Supported browser and user permission for capture |
| ASR | `faster-whisper` 1.2.1, Whisper `tiny.en`, CPU/int8 | Python runtime, PyAV/faster-whisper and complete local ASR model |
| Alternative ASR | OpenAI `whisper` 20250625 with PyTorch | Existing local `.pt` checkpoint, PyTorch, PyAV and Whisper dependencies |
| Learned text score | scikit-learn TF-IDF/logistic regression via `ml/infer.py` | Compatible Python libraries and `models/intent.joblib` |
| Learned replay evidence | SciPy/NumPy LFCC features and scikit-learn RBF SVM | Compatible libraries and `models/replay.joblib` |
| Explicit text rules | `engine.mjs`, `lang-intent.mjs` | Browser or Node.js; no model weights |

## Modern local audio models

The Voice check workspace now exposes two additional, offline operations:

- **Pella v2 + official AASIST** runs both anti-spoof models independently and reports disagreement explicitly. Pella is documented only for English studio/podcast synthetic speech and is not validated for voice conversion, noisy calls, singing, or other languages. AASIST is an ASVspoof 2019 logical-access model. Neither output is an authenticity or identity verdict.
- **ECAPA-TDNN comparison** compares an uploaded reference caller clip with a recorded challenge reply. The returned cosine similarity is supplementary, channel-dependent evidence. No threshold is used and the UI always reports that identity is not established.

All inference runs locally with network access disabled by the server environment. Model files live under `work/models`, the reviewed AASIST checkout lives under `work/quarantine/aasist`, and machine-specific assets remain excluded from version control. Exact upstream revisions, selected file hashes, and the security review boundary are recorded in `models/third_party_models.json`. Pella and AASIST checkpoints are loaded with `torch.load(..., weights_only=True)` and strict state-dict matching; remote custom code and Hugging Face `trust_remote_code` are not used.

On the installed CPU runtime, the bundled faster-whisper `tiny.en` model is the default ASR backend. `work/runtime.json` uses workspace-relative paths so the project does not depend on another user's profile directory.

ASR is [faster-whisper](https://github.com/SYSTRAN/faster-whisper) using [Whisper tiny.en](https://huggingface.co/Systran/faster-whisper-tiny.en). It is English-only, and the expected challenge phrase is never passed as an ASR prompt.

The alternative uses the existing [OpenAI Whisper](https://github.com/openai/whisper) library and passes an explicit local checkpoint filename to `whisper.load_model`, never a downloadable model name. The multilingual checkpoint detects language automatically; the `tiny.en` backend remains fixed to English. Both backends use PyAV for bounded in-memory audio decoding; no external FFmpeg executable is needed. Neither receives the challenge phrase or authored script as a prompt.

`AEGIS_ASR_PYTHON`, `AEGIS_ASR_MODEL` and `AEGIS_ASR_BACKEND` override the interpreter, model and backend. Valid backends are `faster-whisper` (default) and `openai-whisper`. Optional `work/runtime.json` persists local settings:

```json
{
  "python": "work\\asr-runtime\\Scripts\\python.exe",
  "asrBackend": "openai-whisper",
  "speechModel": "C:\\models\\medium.pt"
}
```

Environment overrides take precedence. Relative paths resolve from the workspace; malformed configuration is an error, not a silent fallback. `work` is excluded from version control. Update machine-specific paths when moving the project.

### Actual offline validation on this machine

The existing OpenAI Whisper/PyTorch/PyAV runtime now also contains the pinned scikit-learn/SciPy/joblib/SoundFile stack. ASR, intent and replay dependency probes pass with user-site packages disabled. No replacement checkpoint was downloaded. The existing `medium.pt` file was verified against Whisper's official SHA-256:

`345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1`

Real `/api/transcribe` calls on the bundled WAVs produced:

| Audio | Audio duration | ASR inference time | Rules on recognized words |
| --- | --- | --- | --- |
| Digital-arrest demo | 23.7 s | 68.7 s | Strongly suspicious |
| Legitimate-payment demo | 24.7 s | 48.4 s | No concerning combination |

The generated record is `work/local_asr_validation.json`; rerun `node tools\validate-local-asr.mjs` against the running server to reproduce the integration check. These are **two known TTS demos**, not evidence of real-call accuracy, voice authenticity or model generalization.

This CPU `medium` backend is **not real-time**. A later browser run exceeded the original 120-second request limit. OpenAI ASR requests therefore have a bounded four-minute batch budget; other inference requests retain the two-minute limit. The UI reports elapsed time or a failure and never substitutes the demo script. Continuous live capture is disabled for this backend so it cannot silently fall behind and drop most of a call.

The intent and replay classifiers, Pella v2, official AASIST, ECAPA-TDNN and faster-whisper `tiny.en` are installed on this machine. `ml/install_modern_models.py` pins and verifies their revisions and selected asset hashes. Mendeley evaluation reports detector sensitivity only because that corpus contains no genuine class.

Reproducible setup scripts are available for a clean machine:

1. `Setup speech.ps1` installs the modern Python dependencies and hash-pinned Pella, XLS-R, AASIST, ECAPA-TDNN and faster-whisper assets.
2. `Setup datasets.ps1` performs the full text, Mendeley V1 and roughly 1.5 GB ASVspoof setup, then trains/validates the local models. For intent-only work, run `ml\download_data.py --text-only --manifest <local-manifest>` and then `ml\train_text.py`.

Do not run them when downloads are disallowed. They do not change PowerShell execution policy. Only load trusted local joblib artifacts.

## Validation

Run existing tests with `node --test`. Tests cover rule behaviour, source/readiness failures, dataset browsing, demo prefix/seek logic, audio encoding, liveness restrictions and explanation consistency. Mocked ASR responses in integration tests test plumbing, not recognition quality.

With the restored Python runtime, run `python -m unittest discover -s test -p test_audio_io.py` for actual PyAV decoding/resampling checks, bounded-input errors and the ASR adapter contract.

Optional diagnostics:

- `node tools\benchmark-rules.mjs` recomputes the **reused-corpus** diagnostic.
- `node tools\calibrate-channel.mjs` reproduces synthetic channel experiments, not field liveness performance.
- `node tools\calibrate-attack-model.mjs` reproduces four controlled path simulations, not real attack classification accuracy.
- With original assets and a running server, `python test\test_api.py` checks real model-backed API calls.
- The workspace Python environment can run `ml\validate_models.py` to recheck source checksums, split separation and saved predictions.

The historical `models/validation.json`, `api_validation.json` and `browser_validation.json` remain old build records. They are not proof the current machine has the required runtime.

## Remaining gaps

- No independent corpus of consented real scam and legitimate calls, including matched topics and Indian languages.
- No validated modern voice-clone/liveness model, speaker identity verification or transaction enforcement.
- No independently recorded four-class corpus spanning microphones, rooms, codecs, direct injection and multiple real voice-conversion systems. The Attack Lab is an interpretable hypothesis model until that exists.
- No verified real-call false-positive rate or independent ASR accuracy. Timing above is measured on two authored TTS demos, not representative calls.
- Indic-language rules and synthetic channel heuristics need evaluation; passing unit tests does not validate their field performance.

## Interactive human-vishing deployment gate

**This local build uses synthetic conversational data, six real-world NCSU/FTC robocall waveforms, the full 1,432-row NCSU transcript catalogue, saved metadata for an official replay benchmark, and authored TTS demos. No independently labelled interactive human scam-call corpus is installed. Deployment validation has not been performed.**

Robocalls improve telephone-channel realism and campaign-script coverage, but automated or prerecorded calls do not represent a human attacker improvising, responding to resistance, or operating live voice conversion. TeleAntiFraud-28k uses privacy-protected construction including TTS regeneration and synthetic/adversarial expansion. Neither source is counted as interactive human-vishing evidence.

The local evidence audit is `work/datasets/human-vishing/manifest.json`. Start from `models/human_vishing_manifest.example.json` only after a lawful partner supplies recordings. Run `node tools/validate-human-vishing.mjs`; it exits unsuccessfully until the evidence package is complete. The complete protocol is in `HUMAN_VISHING_PROTOCOL.md`. A candidate record is considered only when it has:

- documented consent or another reviewed legal collection basis;
- sensitive-data redaction and independent label verification;
- human caller and interactive-call labels;
- scam category, language/accent, channel/codec, and voice-conversion status;
- speaker, campaign, and matched-topic group identifiers;
- a cryptographic audio hash and an assigned train/development/test split.

Speaker and campaign groups may not cross evaluation splits. Deployment coverage also requires genuine controls in the same `match_group` as scam calls—for example, fake and genuine bank alerts—so topic alone cannot determine the label. Live voice-conversion recordings must use a human speaking through a real VC system over the target WebRTC/PSTN codec, with same-channel genuine speech as the control. Synthetic transforms and prerecorded TTS do not qualify.

The audit recomputes recording and evidence-artifact SHA-256 values, rejects paths outside the corpus directory, and fails closed when a local manifest is corrupt. Evaluation readiness currently requires a byte-verified sealed test set with at least 100 scam and 100 genuine calls, five matched topics with at least ten examples per label, two languages, and two channel/codec conditions. These are minimum engineering gates, not proof of statistical adequacy for every deployment.

After producing one JSON prediction per sealed-test call, run `node tools/evaluate-human-vishing.mjs <manifest> <predictions.jsonl>`. It reports confusion counts, coverage, abstention-inclusive sensitivity/specificity, observed-prevalence precision, and topic/language/accent/channel/codec/VC subgroups. Missing, duplicated, invalid, training, or development predictions are errors.

The Evidence library displays four distinct concepts: manifest candidates, byte-verified calls, evaluation readiness, and evidence-package completeness. It never sets `deploymentValidated` to true; that judgement belongs to independent legal, scientific, privacy, and operational reviewers after examining performance and the target deployment. With the supplied empty template it correctly reports **NOT VALIDATED**.

## Privacy

Text rules and guided demos run in the browser. Real inference requests use loopback only. Uploaded/recorded audio is not automatically written to disk. Exporting session JSON or downloading a recording is explicit. No analytics or local-storage persistence is used. Reset clears displayed session state; a local Python task already running may finish before releasing memory.
