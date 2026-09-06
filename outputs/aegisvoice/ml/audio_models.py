"""Offline adapters for reviewed third-party audio models.

No adapter downloads code or weights. Checkpoints are loaded with PyTorch's
restricted weights-only loader and are expected to be hash-pinned by the setup
manifest in work/models.
"""
import importlib.util
import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np
import torch

from audio_io import MAX_BYTES, decode_audio

ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / "work" / "models"
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_PELLA_MODEL = None
_AASIST_MODEL = None


class PellaDetector(torch.nn.Module):
    def __init__(self):
        super().__init__()
        from transformers import Wav2Vec2Model
        self.backbone = Wav2Vec2Model.from_pretrained(
            MODELS / "wav2vec2-xls-r-300m", local_files_only=True)
        self.layer_weights = torch.nn.Parameter(
            torch.zeros(self.backbone.config.num_hidden_layers + 1))
        self.head = torch.nn.Linear(self.backbone.config.hidden_size, 1)

    def forward(self, value):
        hidden = self.backbone(value, output_hidden_states=True).hidden_states
        weights = torch.softmax(self.layer_weights, dim=0)
        fused = torch.stack(hidden).mul(weights[:, None, None, None]).sum(0).mean(1)
        return self.head(fused).squeeze(-1)


def fixed_audio(samples, length):
    if not len(samples):
        raise ValueError("No decoded audio samples")
    if len(samples) >= length:
        offset = (len(samples) - length) // 2
        return samples[offset:offset + length]
    repeats = int(np.ceil(length / len(samples)))
    return np.tile(samples, repeats)[:length]


def pella(samples):
    global _PELLA_MODEL
    clip = fixed_audio(samples, 4 * 16000).astype(np.float32)
    clip = (clip - clip.mean()) / (clip.std() + 1e-7)
    if _PELLA_MODEL is None:
        model = PellaDetector().to(DEVICE)
        state = torch.load(MODELS / "pella-v2" / "pellav2_detector.pt",
                           map_location=DEVICE, weights_only=True)
        model.load_state_dict(state, strict=True)
        model.eval()
        _PELLA_MODEL = model
    with torch.inference_mode():
        score = torch.sigmoid(_PELLA_MODEL(torch.from_numpy(clip)[None].to(DEVICE))).item()
    return {"available": True, "score": score, "threshold": 0.5,
            "label": "synthetic-like" if score >= .5 else "real-like",
            "model": "Pella v2 / Wav2Vec2-XLS-R-300M",
            "scope": "English studio/podcast synthetic-speech evidence; not validated for voice conversion, noisy calls, singing, or other languages."}


def aasist(samples):
    global _AASIST_MODEL
    if _AASIST_MODEL is None:
        source = ROOT / "work" / "quarantine" / "aasist" / "models" / "AASIST.py"
        spec = importlib.util.spec_from_file_location("reviewed_aasist", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = {"architecture": "AASIST", "nb_samp": 64600, "first_conv": 128,
                  "filts": [70, [1, 32], [32, 32], [32, 64], [64, 64]],
                  "gat_dims": [64, 32], "pool_ratios": [.5, .7, .5, .5],
                  "temperatures": [2., 2., 100., 100.]}
        model = module.Model(config).to(DEVICE)
        state = torch.load(ROOT / "work" / "quarantine" / "aasist" / "models" / "weights" / "AASIST.pth",
                           map_location=DEVICE, weights_only=True)
        model.load_state_dict(state, strict=True)
        model.eval()
        _AASIST_MODEL = model
    clip = torch.from_numpy(fixed_audio(samples, 64600).astype(np.float32))[None].to(DEVICE)
    with torch.inference_mode():
        _, logits = _AASIST_MODEL(clip, Freq_aug=False)
        probabilities = torch.softmax(logits, dim=1)[0]
    score = probabilities[0].item()  # Official protocol: 0 spoof, 1 bonafide.
    return {"available": True, "score": score, "threshold": 0.5,
            "label": "spoof-like" if score >= .5 else "bonafide-like",
            "model": "Official AASIST (ASVspoof 2019 LA)",
            "scope": "Logical-access anti-spoof evidence; scores are not calibrated for real calls or identity decisions."}


def deepfake(payload):
    started = time.perf_counter()
    samples = decode_audio(payload)
    if len(samples) < 16000:
        raise ValueError("At least one second of speech is required")
    detectors = {}
    for name, inference in (("pella", pella), ("aasist", aasist)):
        try:
            detectors[name] = inference(samples)
        except Exception as error:
            detectors[name] = {"available": False, "error": str(error)[:500]}
    usable = [value for value in detectors.values() if value.get("available")]
    labels = [value["label"] in ("synthetic-like", "spoof-like") for value in usable]
    disagreement = len(labels) == 2 and labels[0] != labels[1]
    return {"detectors": detectors, "disagreement": disagreement,
            "status": "Disagreement — manual verification required" if disagreement else
                      ("Synthetic/spoof evidence" if labels and all(labels) else
                       "No synthetic/spoof agreement" if labels else "Unavailable"),
            "identity": "Not established", "inference_ms": round((time.perf_counter()-started)*1000),
            "warning": "Detector outputs are supplementary evidence, not proof that speech or a caller is authentic."}


def speaker(payload):
    if len(payload) < 5:
        raise ValueError("Missing framed reference and comparison audio")
    first_length = struct.unpack(">I", payload[:4])[0]
    if first_length <= 0 or first_length > MAX_BYTES or len(payload) <= 4 + first_length:
        raise ValueError("Invalid speaker-comparison framing")
    reference = decode_audio(payload[4:4 + first_length])
    comparison = decode_audio(payload[4 + first_length:])
    import torchaudio
    # SpeechBrain 1.0.3 still probes an API removed by recent torchaudio. The
    # adapter decodes/resamples with PyAV, so this compatibility shim performs
    # no I/O and only lets SpeechBrain finish importing.
    if not hasattr(torchaudio, "list_audio_backends"):
        torchaudio.list_audio_backends = lambda: ["soundfile"]
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy
    classifier = EncoderClassifier.from_hparams(
        source=str(MODELS / "ecapa-tdnn"), savedir=str(MODELS / "ecapa-tdnn"),
        overrides={"pretrained_path": str(MODELS / "ecapa-tdnn")},
        local_strategy=LocalStrategy.COPY,
        run_opts={"device": str(DEVICE)})
    with torch.inference_mode():
        left = classifier.encode_batch(torch.from_numpy(reference)[None].to(DEVICE)).squeeze()
        right = classifier.encode_batch(torch.from_numpy(comparison)[None].to(DEVICE)).squeeze()
        similarity = torch.nn.functional.cosine_similarity(left.flatten(), right.flatten(), dim=0).item()
    return {"available": True, "cosineSimilarity": similarity, "model": "SpeechBrain ECAPA-TDNN VoxCeleb",
            "decision": "No identity decision", "identity": "Not established",
            "warning": "Similarity is channel- and enrollment-dependent supplementary evidence; it is never identity proof."}


def main():
    command = sys.argv[1]
    payload = sys.stdin.buffer.read(MAX_BYTES * 2 + 5)
    if len(payload) > MAX_BYTES * 2 + 4:
        raise ValueError("Speaker comparison exceeds two 64 MB media files")
    result = deepfake(payload) if command == "deepfake" else speaker(payload)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)[:1000]}))
        sys.exit(1)
