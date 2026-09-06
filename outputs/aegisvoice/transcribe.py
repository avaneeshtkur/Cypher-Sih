"""Local ASR from binary stdin. Never substitutes authored text for recognized speech."""
import json
import os
import sys
import time
from functools import lru_cache
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import av
import numpy as np
from ml.audio_io import decode_audio, MAX_BYTES, SAMPLE_RATE


@lru_cache(maxsize=1)
def load_model(model_path, backend):
    path = Path(model_path)
    if backend == "openai-whisper":
        if not path.is_file():
            raise ValueError("OpenAI Whisper requires an existing local checkpoint file")
        import torch
        import whisper
        torch.set_num_threads(2)
        # A file path (not a model name) prevents Whisper's automatic downloader.
        return whisper.load_model(str(path), device="cpu").eval()
    if backend == "faster-whisper":
        if not path.is_dir():
            raise ValueError("faster-whisper requires an existing local model directory")
        from faster_whisper import WhisperModel
        return WhisperModel(str(path), device="cpu", compute_type="int8",
                            cpu_threads=2, local_files_only=True)
    raise ValueError(f"Unsupported ASR backend: {backend}")


def transcribe(payload, model_path, backend="faster-whisper"):
    started = time.monotonic()
    audio = decode_audio(payload)
    duration = len(audio) / SAMPLE_RATE
    name = Path(model_path).name
    response = {
        "text": "", "segments": [], "duration": duration, "model": name,
        "backend": backend, "transcriptSource": "local-asr", "language": "unknown",
        "note": "Recognized from waveform, not a supplied script. Review errors; identity is not established."
    }
    if not len(audio) or float(np.sqrt(np.mean(audio ** 2))) < 0.0001:
        response["note"] = "No usable speech"
    else:
        model = load_model(str(Path(model_path).resolve()), backend)
        # No challenge phrase or scenario script is supplied as an ASR prompt.
        if backend == "openai-whisper":
            result = model.transcribe(
                audio, task="transcribe", fp16=False,
                temperature=0, beam_size=1, condition_on_previous_text=False,
                word_timestamps=False, verbose=None
            )
            response["language"] = result.get("language") or "unknown"
            response["text"] = result["text"].strip()
            response["segments"] = [
                {"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
                for s in result["segments"]
            ]
        else:
            segments, info = model.transcribe(
                audio, language="en", beam_size=5, vad_filter=True,
                condition_on_previous_text=False, word_timestamps=True
            )
            response["language"] = getattr(info, "language", None) or "en"
            response["segments"] = [
                {"start": s.start, "end": s.end, "text": s.text.strip(),
                 "words": [{"start": w.start, "end": w.end, "word": w.word} for w in s.words or []]}
                for s in segments
            ]
            response["text"] = " ".join(s["text"] for s in response["segments"])
    response["inference_ms"] = round((time.monotonic() - started) * 1000)
    return response


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        result = transcribe(sys.stdin.buffer.read(MAX_BYTES + 1), sys.argv[1],
                            os.environ.get("AEGIS_ASR_BACKEND", "faster-whisper"))
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, RuntimeError, OSError, av.error.FFmpegError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
