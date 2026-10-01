#!/bin/bash
set -e
pnpm install --frozen-lockfile
uv sync --frozen
uv run --frozen python artifacts/api-server/scripts/setup-transcription.py
pnpm --filter @workspace/db run push
