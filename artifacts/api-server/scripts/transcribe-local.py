#!/usr/bin/env python3
"""Transcribe one prepared MP3 using the pre-downloaded local Whisper model."""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

MAX_AUDIO_BYTES = 24 * 1024 * 1024
MAX_OUTPUT_BYTES = 10 * 1024 * 1024
MAX_WORDS = 100_000
MIN_MODEL_BYTES = 1024 * 1024
MODEL_ID = "Systran/faster-whisper-base"


class TranscriptionError(Exception):
    pass


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def model_directory() -> Path:
    return workspace_root() / ".cache" / "clipwise-transcription" / "base"


def has_model_files(directory: Path) -> bool:
    try:
        required = ("config.json", "model.bin", "tokenizer.json")
        if any(not (directory / name).is_file() for name in required):
            return False
        model_file = directory / "model.bin"
        if model_file.stat().st_size < MIN_MODEL_BYTES:
            return False
        return any(
            (directory / name).is_file() and (directory / name).stat().st_size > 0
            for name in ("vocabulary.json", "vocabulary.txt")
        )
    except OSError:
        return False


def audio_duration_seconds(audio_path: Path) -> float:
    try:
        import av

        with av.open(str(audio_path), mode="r") as container:
            audio_stream = next(
                (stream for stream in container.streams if stream.type == "audio"),
                None,
            )
            duration = None
            if (
                audio_stream is not None
                and audio_stream.duration is not None
                and audio_stream.time_base is not None
            ):
                duration = float(audio_stream.duration * audio_stream.time_base)
            if duration is None and container.duration is not None:
                duration = float(container.duration / av.time_base)
    except ImportError as exc:
        missing_library = next(
            (
                library
                for library in ("libz.so.1", "libstdc++.so.6")
                if library in str(exc)
            ),
            None,
        )
        if missing_library:
            raise TranscriptionError(
                f"Local transcription requires the Nix runtime library ({missing_library})."
            ) from exc
        raise TranscriptionError(
            "The local transcription audio decoder is unavailable."
        ) from exc
    except Exception as exc:
        raise TranscriptionError("The prepared MP3 could not be decoded.") from exc

    if duration is None or not math.isfinite(duration) or duration <= 0:
        raise TranscriptionError("The prepared MP3 has no valid audio duration.")
    return duration


def adapt_pyav_for_faster_whisper() -> None:
    """Bridge the removed PyAV 19 metadata_errors kwarg used by faster-whisper."""
    import av

    original_open = av.open

    def open_without_removed_metadata_option(*args: object, **kwargs: object):
        kwargs.pop("metadata_errors", None)
        return original_open(*args, **kwargs)

    av.open = open_without_removed_metadata_option


def transcribe(audio_path: Path, output_path: Path) -> None:
    if not audio_path.is_file():
        raise TranscriptionError("The prepared MP3 does not exist.")
    if audio_path.suffix.lower() != ".mp3":
        raise TranscriptionError("Local transcription accepts prepared MP3 audio only.")
    if audio_path.stat().st_size <= 0:
        raise TranscriptionError("The prepared MP3 is empty.")
    if audio_path.stat().st_size > MAX_AUDIO_BYTES:
        raise TranscriptionError("The prepared MP3 exceeds the 24 MB limit.")
    if audio_path.parent.resolve() != output_path.parent.resolve():
        raise TranscriptionError("The transcription output must be in the audio work directory.")
    if not has_model_files(model_directory()):
        raise TranscriptionError(
            "The local transcription model is missing. Run "
            "python3 artifacts/api-server/scripts/setup-transcription.py "
            "before processing jobs."
        )

    duration = audio_duration_seconds(audio_path)

    # Offline mode is set before importing the model library; per-job audio never
    # triggers a model or other network download.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        adapt_pyav_for_faster_whisper()
        from faster_whisper import WhisperModel

        model = WhisperModel(
            str(model_directory()),
            device="cpu",
            compute_type="int8",
            cpu_threads=2,
            num_workers=1,
            local_files_only=True,
        )
        segments, _info = model.transcribe(
            str(audio_path),
            task="transcribe",
            language=None,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={
                "threshold": 0.5,
                "min_speech_duration_ms": 100,
                "min_silence_duration_ms": 400,
                "speech_pad_ms": 150,
            },
        )
        words: list[dict[str, float | str]] = []
        for segment in segments:
            for word in segment.words or ():
                text = str(word.word or "").strip()
                start = float(word.start)
                end = float(word.end)
                if (
                    not text
                    or len(text) > 4_000
                    or not math.isfinite(start)
                    or not math.isfinite(end)
                ):
                    continue
                start = max(0.0, start)
                end = min(duration, end)
                if end <= start:
                    continue
                words.append({"text": text, "start": start, "end": end})
                if len(words) > MAX_WORDS:
                    raise TranscriptionError(
                        "The transcript exceeds the 100,000-word safety limit."
                    )
    except TranscriptionError:
        raise
    except ImportError as exc:
        missing_library = next(
            (
                library
                for library in ("libz.so.1", "libstdc++.so.6")
                if library in str(exc)
            ),
            None,
        )
        if missing_library:
            raise TranscriptionError(
                f"Local transcription requires the Nix runtime library ({missing_library})."
            ) from exc
        raise TranscriptionError(
            "The local faster-whisper Python dependencies are unavailable."
        ) from exc
    except Exception as exc:
        raise TranscriptionError(
            f"Local transcription failed ({type(exc).__name__})."
        ) from exc

    try:
        encoded = json.dumps(
            {"words": words},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(encoded) > MAX_OUTPUT_BYTES:
            raise TranscriptionError("The local transcript exceeds the 10 MB safety limit.")
        output_path.write_bytes(encoded)
    except TranscriptionError:
        raise
    except OSError as exc:
        raise TranscriptionError("The local transcription result could not be saved.") from exc


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: transcribe-local.py AUDIO.mp3 OUTPUT.json", file=sys.stderr)
        return 2
    try:
        transcribe(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except TranscriptionError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Local transcription failed ({type(exc).__name__}).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())