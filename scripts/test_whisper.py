#!/usr/bin/env python3
"""Record from mic (or use a WAV file) and transcribe with Luna's Whisper settings."""

from __future__ import annotations

import argparse
import os
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "base")
DEFAULT_PROMPT = os.environ.get(
    "WHISPER_INITIAL_PROMPT",
    "Discord voice chat with Krisp noise suppression. Wake phrases: Hey Luna, Hello Luna.",
)
DEFAULT_NO_SPEECH_THRESHOLD = float(os.environ.get("WHISPER_NO_SPEECH_THRESHOLD", "0.35"))
SAMPLE_RATE = 16_000


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)


def record_seconds(seconds: float, device: int | None) -> bytes:
    import numpy as np
    import sounddevice as sd

    print(f"\nRecording {seconds:.0f}s from microphone...")
    print('Speak now — try: "Hey Luna, can you hear me?"\n')
    audio = sd.rec(
        int(seconds * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        device=device,
    )
    sd.wait()
    return audio.tobytes()


def transcribe(wav_path: Path, model_name: str, initial_prompt: str, no_speech_threshold: float) -> str:
    from faster_whisper import WhisperModel

    device = "cuda"
    compute_type = "float16"
    try:
        import torch

        if not torch.cuda.is_available():
            device = "cpu"
            compute_type = "int8"
    except Exception:
        device = "cpu"
        compute_type = "int8"

    print(f"Loading Whisper model '{model_name}' on {device}...")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    print("Transcribing...")
    segments, info = model.transcribe(
        str(wav_path),
        language="en",
        initial_prompt=initial_prompt,
        vad_filter=False,
        condition_on_previous_text=False,
        no_speech_threshold=no_speech_threshold,
        beam_size=3,
        best_of=3,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    return text, info


def wake_check(text: str) -> str:
    normalized = text.lower().strip()
    phrases = [p.strip() for p in os.environ.get("LUNA_WAKE_PHRASES", "hey luna,hello luna").split(",") if p.strip()]
    matched = any(p in normalized for p in phrases)
    fuzzy = any(
        token in normalized
        for token in ("hey luna", "hello luna", "you luna", "hay luna")
    ) or normalized.startswith("luna")
    if matched or fuzzy:
        return "YES — wake phrase would trigger Luna"
    return "NO — Luna would ignore this (wake phrase not detected)"


def main() -> int:
    load_env()
    parser = argparse.ArgumentParser(description="Test Whisper STT with Luna settings")
    parser.add_argument("--record", type=float, default=5.0, help="Seconds to record from mic")
    parser.add_argument("--file", type=str, help="Transcribe an existing 16kHz mono WAV instead")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--no-speech-threshold", type=float, default=DEFAULT_NO_SPEECH_THRESHOLD)
    parser.add_argument("--device", type=int, default=None, help="Input device index (see --list-devices)")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--keep-wav", action="store_true", help="Keep recorded WAV in data/")
    args = parser.parse_args()

    if args.list_devices:
        import sounddevice as sd

        print(sd.query_devices())
        return 0

    data_dir = ROOT / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    wav_path = data_dir / "whisper-test.wav"

    if args.file:
        wav_path = Path(args.file)
        if not wav_path.is_file():
            print(f"File not found: {wav_path}", file=sys.stderr)
            return 1
        print(f"Using file: {wav_path}")
    else:
        pcm = record_seconds(args.record, args.device)
        write_wav(wav_path, pcm)
        duration = len(pcm) / (SAMPLE_RATE * 2)
        print(f"Saved {duration:.1f}s recording → {wav_path}")

    text, info = transcribe(wav_path, args.model, args.prompt, args.no_speech_threshold)
    print("\n" + "=" * 50)
    print("TRANSCRIPT:")
    print(text or "(empty)")
    print("=" * 50)
    print(f"Detected language: {getattr(info, 'language', '?')} (prob {getattr(info, 'language_probability', 0):.2f})")
    print(f"Wake phrase check: {wake_check(text)}")
    if not args.file and not args.keep_wav:
        print(f"\nWAV kept at: {wav_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
