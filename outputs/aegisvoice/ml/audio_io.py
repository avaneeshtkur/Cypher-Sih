"""Bounded in-memory decoding via PyAV; no FFmpeg executable or ASR model needed."""
import io

import av
import numpy as np

SAMPLE_RATE = 16000
MAX_SECONDS = 120
MAX_BYTES = 64 * 1024 * 1024


def decode_audio(payload):
    if not payload:
        raise ValueError("No audio received")
    if len(payload) > MAX_BYTES:
        raise ValueError("Media file exceeds 64 MB")
    parts = []
    sample_count = 0
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
    with av.open(io.BytesIO(payload)) as container:
        if not container.streams.audio:
            raise ValueError("Input has no audio stream")
        if container.duration and container.duration / av.time_base > MAX_SECONDS:
            raise ValueError("Audio exceeds two minutes")
        for frame in container.decode(audio=0):
            for output in resampler.resample(frame):
                values = output.to_ndarray().reshape(-1)
                sample_count += len(values)
                if sample_count > SAMPLE_RATE * MAX_SECONDS:
                    raise ValueError("Audio exceeds two minutes")
                parts.append(values)
        for output in resampler.resample(None):
            values = output.to_ndarray().reshape(-1)
            sample_count += len(values)
            if sample_count > SAMPLE_RATE * MAX_SECONDS:
                raise ValueError("Audio exceeds two minutes")
            parts.append(values)
    audio = np.concatenate(parts).astype(np.float32) if parts else np.empty(0, np.float32)
    if not np.isfinite(audio).all():
        raise ValueError("Audio contains non-finite samples")
    return audio
