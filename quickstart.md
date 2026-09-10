# AegisVoice Quickstart Guide

This document is designed for developers and AI agents to quickly start, configure, test, and understand the AegisVoice local call-verification prototype without needing to re-analyze the codebase.

---

## 1. Quick Launch (TL;DR)

### Run from Workspace Root
```bash
node outputs/aegisvoice/server.mjs
```

### Or Run from `outputs/aegisvoice`
```bash
cd outputs/aegisvoice
npm start
# or: node server.mjs
```

### Windows Shortcut
Double-click `outputs/aegisvoice/Start AegisVoice.cmd` (or run it from cmd/PowerShell).

- **Local URL:** [http://127.0.0.1:4173](http://127.0.0.1:4173)
- **Port:** Default is `4173` (customizable via `PORT` environment variable).
- **Node.js dependencies:** **None!** Zero external `npm` packages required; the server runs entirely on standard Node.js built-ins (`node:http`, `node:fs`, `node:child_process`).

---

## 2. System Architecture & Project Layout

```
SIH_Diamond/
├── quickstart.md                    # This guide
├── outputs/
│   └── aegisvoice/
│       ├── server.mjs               # Node.js HTTP backend (API endpoints & static file serving)
│       ├── index.html               # Main single-page web application UI
│       ├── app.js                   # Application coordinator & event bindings
│       ├── engine.mjs               # Core behavioral transcript analysis rule engine
│       ├── lang-intent.mjs          # Multilingual phrasing & intent heuristics
│       ├── attack-model.mjs         # Rolling DSP acoustic delivery path model
│       ├── liveness-core.mjs        # Voice check phrase liveness evaluation
│       ├── server-readiness.mjs     # Capability probing & health-check logic
│       ├── models/                  # Pre-compiled joblib models, source manifests & reports
│       ├── demo-audio/              # Bundled TTS demo WAVs for Call Desk
│       ├── database-audio/          # Packaged audio samples for testing
│       ├── ml/                      # Python ML inference scripts (ASR, deepfake, speaker)
│       ├── tools/                   # Benchmarking, calibration, and validation utilities
│       └── test/                    # Node.js and Python test suites
└── work/
    ├── runtime.json                 # Local configuration for Python path and ASR model
    └── models/                      # Offline model weights (faster-whisper, pella-v2, etc.)
```

---

## 3. Runtime Modes & Requirements

AegisVoice is built with graceful degradation:

| Capability | Requires Python? | Description |
|---|:---:|---|
| **Guided Demos & UI** | ❌ No | Plays bundled audio clips (`payment-pressure.wav`, `digital-arrest.wav`, etc.) and runs exact transcript rules in real-time. |
| **Transcript Lab** | ❌ No | Analyzes caller/employee dialogue using inspectable rule logic without external calls. |
| **Attack Lab** | ❌ No | DSP-based acoustic path analysis (microphone, line-in, synthetic) in-browser. |
| **Evidence Library** | ❌ No | Browses saved benchmarks, scenario cases, and diagnostic reports. |
| **Local ASR Transcribe** |  Yes | Transcribes audio via `faster-whisper` (default) or `openai-whisper`. |
| **Deepfake Detection** |  Yes | Pella v2 + AASIST anti-spoofing models via PyTorch. |
| **Speaker Comparison** |  Yes | ECAPA-TDNN speaker embedding cosine similarity. |
| **Learned Intent Score** |  Yes | Scikit-learn TF-IDF classifier via `ml/infer.py`. |

---

## 4. Configuring the Python Backend (`work/runtime.json`)

If you want to use the full ML capabilities (ASR, deepfake detection, speaker verification), configure `work/runtime.json`.

### macOS / Linux Example:
```json
{
  "python": "python3",
  "asrBackend": "faster-whisper",
  "speechModel": "work/models/faster-whisper-tiny.en"
}
```

### Windows Example:
```json
{
  "python": "work\\asr-runtime\\Scripts\\python.exe",
  "asrBackend": "faster-whisper",
  "speechModel": "work\\models\\faster-whisper-tiny.en"
}
```

### Environment Variable Overrides:
You can also override settings on startup without changing `runtime.json`:
```bash
export AEGIS_ASR_PYTHON="python3"
export AEGIS_ASR_BACKEND="faster-whisper" # or "openai-whisper"
export AEGIS_ASR_MODEL="work/models/faster-whisper-tiny.en"
export PORT="4173"
node outputs/aegisvoice/server.mjs
```

---

## 5. Main Workspaces in the Web App

1. **Call Desk:**
   - **Guided Demo:** Select one of the 4 demo audio clips to see simulated real-time transcript analysis and rule triggers.
   - **Recognize Audio with Local ASR:** Sends chosen WAV to `/api/transcribe` for real model transcription and rule evaluation.
   - **Live Audio:** Captures microphone input (streaming requires compatible fast ASR backend).

2. **Transcript Lab:**
   - Paste dialogue (`Caller: ...` / `Employee: ...`) or load an authored case.
   - Immediately checks against 18 baseline fraud/genuine patterns (CFO fraud, digital arrest, KYC OTP, etc.).

3. **Voice Check:**
   - Issues single-use 2-minute dynamic challenge phrases.
   - Profiles audio reply and performs deepfake anti-spoofing and speaker verification.

4. **Evidence Library:**
   - Interactive database of research datasets (NCSU FTC robocalls, BothBosu, Mendeley Fake Audio).

5. **Attack Lab:**
   - DSP-based audio path classifier distinguishing physical speakers, direct injection, live voice conversion, and room reflections.

---

## 6. Testing & Validation Commands

### Run Node.js Unit Tests:
```bash
cd outputs/aegisvoice
npm test
# Equivalent to: node --test
```

### Run Python Audio/Model Tests (if Python dependencies installed):
```bash
python3 -m unittest discover -s outputs/aegisvoice/test -p "test_*.py"
```

### Run Calibration & Benchmarking Tools:
```bash
cd outputs/aegisvoice
node tools/benchmark-rules.mjs            # Benchmark transcript rule engine
node tools/calibrate-attack-model.mjs     # Calibrate attack path DSP model
node tools/calibrate-channel.mjs          # Channel response calibration
```

### Validate Local ASR (with server running):
```bash
node outputs/aegisvoice/tools/validate-local-asr.mjs
```

---

## 7. Common Gotchas & Troubleshooting

- **Server Binds to Loopback:**
  The server listens strictly on `127.0.0.1`. Requests with mismatched `Origin` headers will receive HTTP 403.
- **Python Missing Modules:**
  If `/api/status` reports capabilities as `false`, check `/api/status` JSON response for specific missing Python libraries (`numpy`, `av`, `torch`, `faster_whisper`, `scikit-learn`).
- **Paths in `work/runtime.json`:**
  Paths can be relative to the workspace root or absolute. On Windows, use double backslashes `\\` or forward slashes `/`.

