import io
import sys
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import av
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.audio_io import decode_audio, SAMPLE_RATE, MAX_BYTES
from transcribe import transcribe, load_model


def wav(seconds=1, rate=22050, channels=1, audible=True):
    samples = np.arange(int(rate * seconds))
    values = np.sin(samples * (2 * np.pi * 440 / rate)) * 12000 if audible else np.zeros(len(samples))
    pcm = np.repeat(values.astype("<i2")[:, None], channels, axis=1)
    data = io.BytesIO()
    with wave.open(data, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm.tobytes())
    return data.getvalue()


def mp4_aac(seconds=1, rate=16000):
    samples = np.sin(np.arange(int(rate * seconds), dtype=np.float32) * (2 * np.pi * 440 / rate)) * 0.25
    encoded = io.BytesIO()
    with av.open(encoded, mode="w", format="mp4") as container:
        stream = container.add_stream("aac", rate=rate)
        stream.layout = "mono"
        stream.bit_rate = 64000
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="flt", layout="mono")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return encoded.getvalue()


class AudioInputTests(unittest.TestCase):
    def test_pyav_decodes_and_resamples_real_wav_bytes(self):
        for rate, channels in [(22050, 1), (48000, 2)]:
            audio = decode_audio(wav(rate=rate, channels=channels))
            self.assertEqual(audio.dtype, np.float32)
            self.assertEqual(len(audio), SAMPLE_RATE)
            self.assertTrue(np.isfinite(audio).all())
            self.assertGreater(float(np.sqrt(np.mean(audio ** 2))), 0.1)

    def test_pyav_decodes_aac_audio_from_an_mp4_container(self):
        audio = decode_audio(mp4_aac())
        self.assertEqual(audio.dtype, np.float32)
        self.assertGreaterEqual(len(audio), SAMPLE_RATE)
        self.assertLess(len(audio), SAMPLE_RATE * 2)
        self.assertGreater(float(np.sqrt(np.mean(audio ** 2))), 0.1)

    def test_empty_invalid_oversized_and_overlong_inputs_fail(self):
        for data in [b"", b"not audio", b"\0" * (MAX_BYTES + 1), wav(seconds=121, rate=8000, audible=False)]:
            with self.assertRaises((ValueError, av.error.FFmpegError)):
                decode_audio(data)

    def test_silence_does_not_load_any_model(self):
        with patch("transcribe.load_model") as model:
            result = transcribe(wav(audible=False), "unused.pt", "openai-whisper")
            model.assert_not_called()
            self.assertEqual(result["text"], "")
            self.assertEqual(result["note"], "No usable speech")

    def test_missing_checkpoint_never_triggers_a_downloader(self):
        with self.assertRaisesRegex(ValueError, "existing local checkpoint"):
            load_model(str(Path(__file__).with_name("missing-checkpoint.pt")), "openai-whisper")

    def test_openai_adapter_receives_audio_not_the_authored_script(self):
        calls = []

        class Model:
            def transcribe(self, audio, **kwargs):
                calls.append((audio, kwargs))
                return {"text": "recognized test words", "language": "hi", "segments": [{"start": 0, "end": 1, "text": "recognized test words"}]}

        with patch("transcribe.load_model", return_value=Model()):
            result = transcribe(wav(), "existing.pt", "openai-whisper")
        self.assertEqual(result["transcriptSource"], "local-asr")
        self.assertEqual(result["backend"], "openai-whisper")
        self.assertEqual(result["text"], "recognized test words")
        self.assertEqual(result["language"], "hi")
        audio, options = calls[0]
        self.assertIsInstance(audio, np.ndarray)
        self.assertEqual(len(audio), SAMPLE_RATE)
        self.assertNotIn("initial_prompt", options)
        self.assertNotIn("language", options)
        self.assertFalse(options["condition_on_previous_text"])
        self.assertFalse(options["fp16"])


if __name__ == "__main__":
    unittest.main()
