"""Install hash-pinned offline speech and voice-analysis model assets."""
import hashlib, json, subprocess, time
from pathlib import Path
from huggingface_hub import snapshot_download

APP = Path(__file__).resolve().parents[1]
WORK = APP.parents[1] / "work"
MODELS = WORK / "models"
QUARANTINE = WORK / "quarantine"
MANIFEST = json.loads((APP / "models" / "third_party_models.json").read_text(encoding="utf-8"))["models"]

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024): value.update(block)
    return value.hexdigest()

def require(path, expected):
    if not path.is_file() or digest(path) != expected:
        raise ValueError(f"Integrity verification failed: {path}")

def require_file(path):
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Required model asset is missing or empty: {path}")

def retry(label, operation, attempts=3):
    for attempt in range(1, attempts + 1):
        try:
            print(f"{label} (attempt {attempt}/{attempts})", flush=True)
            return operation()
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(2 ** (attempt - 1))

def snapshot(repo, revision, destination, patterns=None):
    destination.mkdir(parents=True, exist_ok=True)
    retry(f"Downloading {repo} at {revision[:12]}", lambda: snapshot_download(
        repo_id=repo, revision=revision, local_dir=destination,
        allow_patterns=patterns))

def git(*args):
    retry("Running git " + " ".join(args[:2]), lambda: subprocess.run(
        ["git", *args], check=True, timeout=300))

MODELS.mkdir(parents=True, exist_ok=True)
snapshot("Systran/faster-whisper-tiny.en", MANIFEST["fasterWhisperTinyEn"]["revision"],
         MODELS / "faster-whisper-tiny.en")
snapshot("facebook/wav2vec2-xls-r-300m", MANIFEST["wav2vec2XlsR300m"]["revision"],
         MODELS / "wav2vec2-xls-r-300m")
snapshot("Sadanie/pellav2-audio-deepfake-detector", MANIFEST["pellaV2"]["revision"],
         MODELS / "pella-v2", ["pellav2_detector.pt"])
snapshot("speechbrain/spkrec-ecapa-voxceleb", MANIFEST["ecapaTdnn"]["revision"],
         MODELS / "ecapa-tdnn")

aasist = QUARANTINE / "aasist"
if not (aasist / ".git").is_dir():
    if aasist.exists():
        raise ValueError(f"Incomplete AASIST checkout exists at {aasist}; inspect or remove it before retrying.")
    aasist.parent.mkdir(parents=True, exist_ok=True)
    git("clone", "--filter=blob:none", "https://github.com/clovaai/aasist.git", str(aasist))
git("-C", str(aasist), "fetch", "--depth", "1", "origin", MANIFEST["aasist"]["revision"])
git("-C", str(aasist), "checkout", "--detach", "--force", MANIFEST["aasist"]["revision"])

require(MODELS / "faster-whisper-tiny.en" / "model.bin", MANIFEST["fasterWhisperTinyEn"]["modelSha256"])
require(MODELS / "wav2vec2-xls-r-300m" / "pytorch_model.bin", MANIFEST["wav2vec2XlsR300m"]["checkpointSha256"])
require(MODELS / "pella-v2" / "pellav2_detector.pt", MANIFEST["pellaV2"]["checkpointSha256"])
require(MODELS / "ecapa-tdnn" / "embedding_model.ckpt", MANIFEST["ecapaTdnn"]["embeddingSha256"])
require(aasist / "models" / "weights" / "AASIST.pth", MANIFEST["aasist"]["checkpointSha256"])
for asset in [
    MODELS / "faster-whisper-tiny.en" / "config.json",
    MODELS / "faster-whisper-tiny.en" / "tokenizer.json",
    MODELS / "faster-whisper-tiny.en" / "vocabulary.txt",
    MODELS / "wav2vec2-xls-r-300m" / "config.json",
    MODELS / "ecapa-tdnn" / "hyperparams.yaml",
    MODELS / "ecapa-tdnn" / "mean_var_norm_emb.ckpt",
    aasist / "models" / "AASIST.py",
]: require_file(asset)

runtime_path = WORK / "runtime.json"
runtime = json.loads(runtime_path.read_text(encoding="utf-8-sig")) if runtime_path.is_file() else {}
runtime["python"] = "work\\asr-runtime\\Scripts\\python.exe"
runtime.setdefault("asrBackend", "faster-whisper")
if runtime["asrBackend"] == "faster-whisper":
    runtime["speechModel"] = "work\\models\\faster-whisper-tiny.en"
runtime_path.write_text(json.dumps(runtime, indent=2) + "\n", encoding="utf-8")
print("Pella, XLS-R, AASIST, ECAPA-TDNN, and faster-whisper tiny.en are installed and hash verified.")
