"""Local Kokoro narrator: JSON lines over a Unix socket, raw PCM in replies.

One process per machine, one model thread, no speech recognition. Runtime state,
Python environment and model caches belong only to ~/.local/share/ultimate-sounds.
"""

import argparse
import base64
import fcntl
import json
import logging
import math
import os
import queue
import socket
import sys
import threading
import time
from pathlib import Path

HOME = Path.home() / ".local/share/ultimate-sounds"
SOCKET = HOME / "worker.sock"
LOCK = HOME / "worker.lock"
MODEL = "mlx-community/Kokoro-82M-bf16"
# Set before importing MLX/Hugging Face; never inherit another app's model cache.
os.environ["HF_HOME"] = str(HOME / "models/huggingface")
os.environ["HF_HUB_CACHE"] = str(HOME / "models/huggingface/hub")
os.environ["HUGGINGFACE_HUB_CACHE"] = os.environ["HF_HUB_CACHE"]
LANGS = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br", "j": "ja", "z": "cmn"}

model = None
provider = None
jobs = queue.Queue()
state_lock = threading.Lock()
state = {"busy": None, "pending": 0, "last_request": time.monotonic(), "started": time.monotonic(), "stopping": False}
idle_minutes = 15


def backend():
    if sys.platform == "darwin":
        return "mlx-audio"
    if sys.platform == "linux":
        return "kokoro-onnx"
    raise RuntimeError(f"unsupported narrator platform: {sys.platform}")


def get_model():
    global model, provider
    if model is not None:
        return model
    if backend() == "mlx-audio":
        from mlx_audio.tts.utils import load

        loaded = load(MODEL)
        for lang in ("a", "b"):
            for _ in loaded.generate(text="Ready.", lang_code=lang):
                pass
        selected_provider = "MLX"
    else:
        model_path = HOME / "models/kokoro-v1.0.onnx"
        voices_path = HOME / "models/voices-v1.0.bin"
        for path in (model_path, voices_path):
            if not path.is_file():
                raise FileNotFoundError(f"Kokoro asset missing: {path}")
        import onnxruntime as rt
        from kokoro_onnx import Kokoro

        providers = ["CPUExecutionProvider"]
        if "CUDAExecutionProvider" in rt.get_available_providers():
            rt.preload_dlls(directory="")
            providers.insert(0, "CUDAExecutionProvider")
        session = rt.InferenceSession(str(model_path), providers=providers)
        loaded = Kokoro.from_session(session, str(voices_path))
        selected_provider = session.get_providers()[0]
    model, provider = loaded, selected_provider
    logging.info("loaded backend=%s provider=%s model=%s", backend(), provider, MODEL)
    return model


def voices():
    if backend() == "kokoro-onnx":
        return sorted(get_model().get_voices())
    from huggingface_hub import snapshot_download

    snapshot = Path(snapshot_download(repo_id=MODEL, allow_patterns=["voices/*", "*.json"]))
    return sorted(path.stem for path in (snapshot / "voices").glob("*.safetensors"))


def render(request):
    import numpy as np

    if "out" in request:
        raise ValueError("output paths are unsupported; render returns audio in its reply")
    if request.get("model", MODEL) != MODEL:
        raise ValueError(f"only {MODEL} is supported")
    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("render requires nonempty text")
    voice = request.get("voice") or "af_heart"
    speed = request.get("speed", 1.0)
    loaded = get_model()
    if backend() == "kokoro-onnx":
        audio, sample_rate = loaded.create(text=text, voice=voice, speed=speed, lang=LANGS[voice[0]])
        audio = np.asarray(audio)
    else:
        sample_rate = loaded.sample_rate
        if sample_rate != 24000:
            raise ValueError(f"narrator requires 24000 Hz; model produces {sample_rate} Hz")
        parts = [np.asarray(result.audio) for result in loaded.generate(text=text, voice=voice, speed=speed, lang_code=voice[0])]
        if not parts:
            raise RuntimeError("model produced no audio")
        audio = np.concatenate(parts)
    if sample_rate != 24000:
        raise ValueError(f"narrator requires 24000 Hz; model produces {sample_rate} Hz")
    if audio.ndim != 1 or not audio.size:
        raise ValueError("model must produce nonempty mono audio")
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    return {"audio": base64.b64encode(pcm).decode("ascii"), "sampleRate": 24000, "provider": provider}


def status():
    with state_lock:
        return {"pid": os.getpid(), "backend": backend(), "provider": provider,
                "loaded": model is not None, "queue": jobs.qsize(), "busy": state["busy"],
                "uptimeS": round(time.monotonic() - state["started"]), "idleMinutes": idle_minutes}


def handle(request):
    started = time.monotonic()
    request_id = request.get("id") if isinstance(request, dict) else None
    try:
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        op = request.get("op")
        if op == "render":
            result = render(request)
        elif op == "voices":
            result = {"voices": voices()}
        elif op == "status":
            result = status()
        else:
            raise ValueError(f"unsupported narrator op: {op}")
        ms = round((time.monotonic() - started) * 1000)
        if op == "render":
            logging.info("render backend=%s provider=%s sampleRate=24000 ms=%s", backend(), provider, ms)
        return {"id": request_id, "ok": True, **result, "ms": ms}
    except Exception as error:
        return {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}


class Client:
    def __init__(self, conn):
        self.conn = conn
        self.write_lock = threading.Lock()

    def reply(self, message):
        with self.write_lock:
            try:
                self.conn.sendall((json.dumps(message) + "\n").encode())
            except OSError:
                pass  # A disconnected browser does not cancel other clients' work.


def model_thread():
    while True:
        client, request = jobs.get()
        with state_lock:
            state["busy"] = request.get("op")
        try:
            client.reply(handle(request))
        finally:
            with state_lock:
                state["busy"] = None
                state["pending"] -= 1
                state["last_request"] = time.monotonic()
            jobs.task_done()


def serve(client):
    with client.conn, client.conn.makefile("rb") as stream:
        for line in stream:
            try:
                request = json.loads(line)
            except (ValueError, UnicodeDecodeError) as error:
                client.reply({"id": None, "ok": False, "error": f"invalid JSON: {error}"})
                continue
            with state_lock:
                state["last_request"] = time.monotonic()
                if state["stopping"]:
                    return
                if isinstance(request, dict) and request.get("op") != "status":
                    state["pending"] += 1
                    jobs.put((client, request))
                    continue
            client.reply(handle(request))


def run(minutes):
    global idle_minutes
    idle_minutes = minutes
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(LOCK, "a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # The winner owns both the socket and its cleanup.
        logging.basicConfig(filename=HOME / "worker.log", level=logging.INFO,
                            format="%(asctime)s %(message)s")
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            SOCKET.unlink(missing_ok=True)
            server.bind(str(SOCKET))
            SOCKET.chmod(0o600)
            server.listen(16)
            server.settimeout(min(1, minutes * 60))
            state.update(last_request=time.monotonic(), started=time.monotonic(), stopping=False)
            logging.info("listening socket=%s pid=%s backend=%s", SOCKET, os.getpid(), backend())
            threading.Thread(target=model_thread, daemon=True).start()
            while True:
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    with state_lock:
                        if not state["pending"] and time.monotonic() - state["last_request"] >= minutes * 60:
                            state["stopping"] = True
                            logging.info("idle for %s minutes, exiting", minutes)
                            break
                else:
                    with state_lock:
                        state["last_request"] = time.monotonic()
                    threading.Thread(target=serve, args=(Client(conn),), daemon=True).start()
        finally:
            server.close()
            SOCKET.unlink(missing_ok=True)
            # Keep the lock inode: unlinking it would let racing starts hold different locks.
            lock.seek(0)
            lock.truncate()


def positive_minutes(value):
    minutes = float(value)
    if not math.isfinite(minutes) or minutes <= 0:
        raise argparse.ArgumentTypeError("idle minutes must be a positive finite number")
    return minutes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--idle-minutes", type=positive_minutes, default=15)
    run(parser.parse_args().idle_minutes)


if __name__ == "__main__":
    main()
