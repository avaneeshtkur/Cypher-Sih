"""Verify that the running API accepts an audio-bearing MP4 without writing fixtures."""
import io
import json
import math
import os
import urllib.request

import av
import numpy as np


def mp4_aac(seconds=1, rate=16000):
    samples = (np.sin(np.arange(rate * seconds, dtype=np.float32) * (2 * math.pi * 440 / rate)) * 0.25).reshape(1, -1)
    output = io.BytesIO()
    with av.open(output, mode="w", format="mp4") as container:
        stream = container.add_stream("aac", rate=rate)
        stream.layout = "mono"
        stream.bit_rate = 64000
        frame = av.AudioFrame.from_ndarray(samples, format="flt", layout="mono")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return output.getvalue()


if __name__ == "__main__":
    origin = os.environ.get("AEGIS_TEST_URL", "http://127.0.0.1:4173").rstrip("/")
    payload = mp4_aac()
    request = urllib.request.Request(
        origin + "/api/replay", data=payload,
        headers={"Content-Type": "audio/mp4"}, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.load(response)
    if result.get("available") is not True or result.get("status") not in {"Replay-like", "Genuine-like", "Uncertain"}:
        raise AssertionError(f"Unexpected replay response: {result}")
    print(json.dumps({
        "passed": True, "container": "MP4", "codec": "AAC", "bytes": len(payload),
        "endpoint": "/api/replay", "result": result.get("status"), "score": result.get("score")
    }, indent=2))