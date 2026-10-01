#!/usr/bin/env python3
"""Download the public base model once, before local transcription jobs run."""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

MODEL_ID = "Systran/faster-whisper-base"
MIN_MODEL_BYTES = 1024 * 1024
ALLOW_PATTERNS = (
    "config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def model_directory() -> Path:
    return workspace_root() / ".cache" / "clipwise-transcription" / "base"


def has_model_files(directory: Path) -> bool:
    try:
        required = ("config.json", "model.bin", "tokenizer.json")
        if any(not (directory / name).is_file() for name in required):
            return False
        if (directory / "model.bin").stat().st_size < MIN_MODEL_BYTES:
            return False
        return any(
            (directory / name).is_file() and (directory / name).stat().st_size > 0
            for name in ("vocabulary.json", "vocabulary.txt")
        )
    except OSError:
        return False


def download_model(force: bool) -> Path:
    target = model_directory()
    target.parent.mkdir(parents=True, exist_ok=True)
    if has_model_files(target) and not force:
        return target

    try:
        from huggingface_hub import HfApi, snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper and huggingface_hub are unavailable; configure the "
            "project Python environment before downloading the model."
        ) from exc

    # Resolve the model's current public revision once, then download by its
    # immutable commit SHA rather than tracking a moving branch during transfer.
    revision = HfApi().model_info(MODEL_ID, token=False).sha
    if not revision:
        raise RuntimeError("The public transcription model did not provide a revision.")

    staging = Path(
        tempfile.mkdtemp(prefix=".base-download-", dir=target.parent)
    )
    backup = target.with_name(".base-previous")
    try:
        snapshot_download(
            repo_id=MODEL_ID,
            revision=revision,
            allow_patterns=list(ALLOW_PATTERNS),
            local_dir=str(staging),
            token=False,
        )
        if not has_model_files(staging):
            raise RuntimeError(
                "The downloaded model is incomplete; expected its configuration, "
                "weights, tokenizer, and vocabulary."
            )

        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            target.rename(backup)
        try:
            staging.rename(target)
        except Exception:
            if backup.exists() and not target.exists():
                backup.rename(target)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Download a fresh model snapshot even when the local model is ready.",
    )
    args = parser.parse_args()
    try:
        model_path = download_model(args.force)
    except Exception as exc:
        print(f"Transcription model setup failed: {exc}", file=sys.stderr)
        return 1
    print(f"Local transcription model is ready: {model_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())