"""Core narrator tests: no daemon, downloaded models, network or GPU."""

import base64
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

spec = importlib.util.spec_from_file_location("narrator_worker", Path(__file__).parent.parent / "narrator/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

AUDIO = np.array([-2, -0.5, 0, 0.5, 2], dtype=np.float32)
PCM = np.array([-32767, -16383, 0, 16383, 32767], dtype="<i2").tobytes()
REQUEST = {"id": 7, "op": "render", "text": "Hello.", "voice": "bf_emma", "speed": 1.1}


class WorkerTest(unittest.TestCase):
    def assert_audio(self, result, provider):
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["id"], 7)
        self.assertEqual(base64.b64decode(result["audio"]), PCM)
        self.assertEqual(result["sampleRate"], 24000)
        self.assertEqual(result["provider"], provider)
        self.assertIsInstance(result["ms"], int)

    def test_mlx_model_and_pcm(self):
        def generate(**kwargs):
            if kwargs["text"] == "Ready.":
                return iter(())
            return iter([SimpleNamespace(audio=AUDIO[:2]), SimpleNamespace(audio=AUDIO[2:])])

        model = SimpleNamespace(sample_rate=24000, generate=Mock(side_effect=generate))
        loader = Mock(return_value=model)
        with (
            patch.object(worker.sys, "platform", "darwin"),
            patch.object(worker, "model", None),
            patch.object(worker, "provider", None),
            patch.dict(sys.modules, {"mlx_audio.tts.utils": SimpleNamespace(load=loader)}),
        ):
            self.assert_audio(worker.handle(REQUEST), "MLX")
            self.assertIs(worker.get_model(), model)
            loader.assert_called_once_with("mlx-community/Kokoro-82M-bf16")
            self.assertEqual(model.generate.call_args_list[0].kwargs, {"text": "Ready.", "lang_code": "a"})
            self.assertEqual(model.generate.call_args_list[1].kwargs, {"text": "Ready.", "lang_code": "b"})
            self.assertEqual(model.generate.call_args_list[2].kwargs,
                             {"text": "Hello.", "voice": "bf_emma", "speed": 1.1, "lang_code": "b"})

    def test_onnx_model_voices_and_pcm(self):
        for cuda in (False, True):
            with self.subTest(cuda=cuda), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                (home / "models").mkdir()
                (home / "models/kokoro-v1.0.onnx").touch()
                (home / "models/voices-v1.0.bin").touch()
                providers = ["CPUExecutionProvider"]
                if cuda:
                    providers.insert(0, "CUDAExecutionProvider")
                session = SimpleNamespace(get_providers=lambda: providers)
                runtime = SimpleNamespace(
                    get_available_providers=lambda: providers,
                    preload_dlls=Mock(),
                    InferenceSession=Mock(return_value=session),
                )
                model = SimpleNamespace(create=Mock(return_value=(AUDIO, 24000)),
                                        get_voices=lambda: ["bf_emma", "af_heart"])
                kokoro = SimpleNamespace(from_session=Mock(return_value=model))
                with (
                    patch.object(worker.sys, "platform", "linux"),
                    patch.object(worker, "HOME", home),
                    patch.object(worker, "model", None),
                    patch.object(worker, "provider", None),
                    patch.dict(sys.modules, {"onnxruntime": runtime, "kokoro_onnx": SimpleNamespace(Kokoro=kokoro)}),
                ):
                    self.assert_audio(worker.handle(REQUEST), providers[0])
                    self.assertEqual(worker.handle({"id": 8, "op": "voices"})["voices"], ["af_heart", "bf_emma"])
                    runtime.InferenceSession.assert_called_once_with(str(home / "models/kokoro-v1.0.onnx"), providers=providers)
                    kokoro.from_session.assert_called_once_with(session, str(home / "models/voices-v1.0.bin"))
                    self.assertEqual(runtime.preload_dlls.call_count, int(cuda))
                    if cuda:
                        runtime.preload_dlls.assert_called_once_with(directory="")
                    model.create.assert_called_once_with(text="Hello.", voice="bf_emma", speed=1.1, lang="en-gb")


if __name__ == "__main__":
    unittest.main()
