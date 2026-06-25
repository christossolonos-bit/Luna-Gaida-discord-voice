#!/usr/bin/env python3
"""Long-lived STT/TTS worker for Giada local Discord voice (faster-whisper + XTTS)."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

_whisper_model = None
_tts_model = None
_device = "cpu"


def _pick_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _get_whisper(model_name: str):
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        compute_type = "float16" if _device == "cuda" else "int8"
        _whisper_model = WhisperModel(model_name, device=_device, compute_type=compute_type)
    return _whisper_model


def _get_tts():
    global _tts_model
    if _tts_model is None:
        from TTS.api import TTS

        _tts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(_device)
    return _tts_model


def _transcribe(
    wav_path: str,
    model_name: str,
    language: str | None,
    initial_prompt: str | None = None,
    no_speech_threshold: float = 0.35,
) -> str:
    """Transcribe Discord voice audio (already Krisp-denoised on the client).

    Do not apply VAD or extra noise suppression here — Krisp already ran in
    Discord and a second pass would clip word onsets (e.g. 'hey' -> 'you').
    """
    model = _get_whisper(model_name)
    segments, _info = model.transcribe(
        wav_path,
        language=language or None,
        initial_prompt=initial_prompt or None,
        vad_filter=False,
        condition_on_previous_text=False,
        no_speech_threshold=no_speech_threshold,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.8,
        beam_size=3,
        best_of=3,
    )
    return " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()


def _synthesize(text: str, speaker_wav: str, out_wav: str, language: str) -> None:
    tts = _get_tts()
    tts.tts_to_file(
        text=text,
        file_path=out_wav,
        speaker_wav=speaker_wav,
        language=language,
    )


def _respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    global _device
    if len(sys.argv) < 2:
        _respond({"type": "error", "message": "missing config json argument"})
        return 1

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as error:
        _respond({"type": "error", "message": f"invalid config json: {error}"})
        return 1

    _device = config.get("device") or _pick_device()
    whisper_model = config.get("whisper_model", "base")
    speaker_wav = config.get("speaker_wav", "")
    tts_language = config.get("tts_language", "en")
    whisper_language = config.get("whisper_language") or None
    whisper_initial_prompt = config.get("whisper_initial_prompt") or None
    whisper_no_speech_threshold = float(config.get("whisper_no_speech_threshold", 0.35))

    if not speaker_wav or not Path(speaker_wav).is_file():
        _respond({"type": "error", "message": f"speaker wav not found: {speaker_wav}"})
        return 1

    _respond({"type": "ready", "device": _device, "whisper_model": whisper_model})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            op = request.get("op")
            if op == "stt":
                text = _transcribe(
                    request["wav"],
                    whisper_model,
                    whisper_language,
                    whisper_initial_prompt,
                    whisper_no_speech_threshold,
                )
                _respond({"type": "stt", "id": request.get("id"), "text": text})
            elif op == "tts":
                _synthesize(
                    request["text"],
                    speaker_wav,
                    request["out"],
                    request.get("language", tts_language),
                )
                _respond({"type": "tts", "id": request.get("id"), "out": request["out"]})
            elif op == "ping":
                _respond({"type": "pong", "id": request.get("id")})
            else:
                _respond({"type": "error", "id": request.get("id"), "message": f"unknown op: {op}"})
        except Exception as error:
            _respond({
                "type": "error",
                "id": request.get("id") if "request" in locals() else None,
                "message": str(error),
                "trace": traceback.format_exc(),
            })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
